import * as Y from 'yjs'
import type { RoomKeys } from './access.ts'
import { type FileEntry, metaTarget } from './files.ts'
import {
  declare,
  decodeSnapshot,
  decodeUpdate,
  incomplete,
  openKeptFrame,
  sealKeptUpdate,
  trial,
} from './kept-text.ts'
import { decodeLogged, decodeUint64, Kind } from './kinds.ts'

/** Whether an edit was kept by the relay yet: sent and not acknowledged, or all acknowledged. */
export type KeptSync = 'pending' | 'kept'

/** A doc followed as a file, and whether it holds a file's comments. */
export interface KeptTarget {
  doc: Y.Doc
  comments: boolean
}

/** What the client of a room gives and takes. */
export interface KeptHooks {
  /** The docs followed, by the ID of their file. */
  docs(): Iterable<[number, KeptTarget]>
  /** The files the host's snapshot lists. */
  manifest(files: FileEntry[]): void
  /** Sends an update of a doc to the relay as an entry. */
  entry(id: number, update: Uint8Array): void
  sync(state: KeptSync): void
  /** How many entries and snapshots did not hold, in all. */
  skipped(count: number): void
}

interface Pending {
  body: Uint8Array
  id: number
  update: Uint8Array
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/** Applies an update to a doc if it holds under the kept-text checks; throws if not. */
function integrate(doc: Y.Doc, update: Uint8Array, origin?: unknown): void {
  const probe = trial(doc, update)
  const missing = incomplete(probe)
  probe.destroy()
  if (missing) throw new Error('incomplete kept update')
  Y.applyUpdate(doc, update, origin)
}

/**
 * The browser's side of a room kept while its host is away
 * (docs/design/rooms-away.md): edits go to the relay as signed, encrypted
 * entries (the kept-text format), and what the relay logged is applied with
 * the kept-text checks. An entry is pending until the relay sends it back
 * with an id, which acknowledges it.
 *
 * For each file it holds a copy of what the relay holds (the snapshot and
 * the log), to check entries against, to build a file opened later, and to
 * tell on a new connection which edits the relay lacks.
 */
export class KeptAway {
  /** Whether the room is kept: edits are entries, not live updates. */
  active = false
  /** When the relay stops keeping the room, in ms since the epoch. */
  until = 0
  /** The last log entry held, for the next connection; undefined before the first replay. */
  after: number | undefined
  /** Entries and snapshots that did not hold, and were left out. */
  skipped = 0
  private readonly keys: RoomKeys
  private readonly origin: unknown
  private readonly hooks: KeptHooks
  private pending: Pending[] = []
  private relay = new Map<number, Y.Doc>()
  private files: FileEntry[] | undefined

  constructor(keys: RoomKeys, origin: unknown, hooks: KeptHooks) {
    this.keys = keys
    this.origin = origin
    this.hooks = hooks
  }

  /**
   * Seals an update of a doc as an entry, held until the relay logs it. It is
   * held only if `sendable` still says it can go out when it is sealed: what
   * is not sent is found missing after the next replay.
   */
  async entry(id: number, update: Uint8Array, sendable: () => boolean): Promise<Uint8Array | null> {
    const body = await sealKeptUpdate(this.keys, id, update)
    if (!sendable()) return null
    this.pending.push({ body, id, update })
    this.hooks.sync('pending')
    return body
  }

  /** How many entries the relay has not acknowledged. */
  get held(): number {
    return this.pending.length
  }

  /** Lets go of what is held: the room is live and the host takes the state. */
  settle(): void {
    this.active = false
    this.after = undefined
    for (const doc of this.relay.values()) doc.destroy()
    this.relay.clear()
    this.files = undefined
    this.drop()
  }

  /** Brings a doc added after the replay up to date with it. */
  adopt(id: number, doc: Y.Doc, comments: boolean): void {
    const held = this.relay.get(id)
    if (!held) return
    declare(doc, comments)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(held), this.origin)
  }

  /** Takes a message of kind 4, 5 or 6 from the relay. */
  async receive(kind: number, payload: Uint8Array): Promise<void> {
    try {
      if (kind === Kind.Replay) await this.snapshot(payload)
      else if (kind === Kind.LogEnd) this.logEnd(decodeUint64(payload))
      else if (kind === Kind.Logged) await this.logged(payload)
    } catch {
      this.skip(1)
    }
  }

  private skip(count: number): void {
    this.skipped += count
    this.hooks.skipped(this.skipped)
  }

  private drop(): void {
    if (this.pending.length === 0) return
    this.pending = []
    this.hooks.sync('kept')
  }

  // The replay is over: this client holds what the relay does. What it wrote
  // that the relay lacks, such as edits made while disconnected, is sent.
  private logEnd(tail: number | undefined): void {
    if (tail !== undefined) this.after = Math.max(this.after ?? 0, tail)
    this.drop()
    for (const [id, { doc }] of this.hooks.docs()) {
      const held = this.relay.get(id)
      if (!held) continue
      const missing = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(held))
      if (!Y.snapshotContainsUpdate(Y.snapshot(held), missing)) this.hooks.entry(id, missing)
    }
  }

  private async logged(payload: Uint8Array): Promise<void> {
    const logged = decodeLogged(payload)
    if (!logged) throw new Error('invalid logged entry')
    this.after = Math.max(this.after ?? 0, logged.id)
    const mine = this.pending.findIndex((p) => same(p.body, logged.entry))
    if (mine >= 0) {
      const [own] = this.pending.splice(mine, 1)
      try {
        if (own) integrate(this.copyOf(own.id), own.update)
      } catch {
        // Our own edit: it is in our doc, whatever the copy makes of it.
      }
      if (this.pending.length === 0) this.hooks.sync('kept')
      return
    }
    const { id, update } = decodeUpdate(await openKeptFrame(this.keys, logged.entry))
    if (this.files && !this.files.some((file) => file.id === id)) throw new Error('unknown file')
    integrate(this.copyOf(id), update)
    for (const [target, { doc }] of this.hooks.docs()) {
      if (target === id) Y.applyUpdate(doc, update, this.origin)
    }
  }

  // The copy of what the relay holds of a file, made when first needed.
  private copyOf(id: number): Y.Doc {
    let held = this.relay.get(id)
    if (!held) {
      const listed = this.files?.find((file) => file.id === id)
      const target = [...this.hooks.docs()].find(([i]) => i === id)?.[1]
      held = declare(new Y.Doc(), listed ? listed.format === 'meta' : (target?.comments ?? false))
      this.relay.set(id, held)
    }
    return held
  }

  // The host's snapshot of every file: the start of the docs, and the files they are.
  private async snapshot(bundle: Uint8Array): Promise<void> {
    const opened = decodeSnapshot(await openKeptFrame(this.keys, bundle))
    const files =
      opened.kind === 'bundle' ? opened.files : [{ id: 0, path: '', update: opened.update }]
    // A file whose path is the metadata path of another is that file's comments.
    const paths = new Set(files.map((file) => file.path))
    const listed = files.map(({ id, path }) => {
      const target = metaTarget(path)
      return { id, path, format: target !== undefined && paths.has(target) ? 'meta' : 'text' }
    })
    if (opened.kind === 'bundle') this.files = listed
    for (const doc of this.relay.values()) doc.destroy()
    this.relay.clear()
    for (const file of files) {
      try {
        integrate(this.copyOf(file.id), file.update)
      } catch {
        this.skip(1)
      }
    }
    for (const [id, { doc }] of this.hooks.docs()) {
      const held = this.relay.get(id)
      if (held) Y.applyUpdate(doc, Y.encodeStateAsUpdate(held), this.origin)
    }
    if (opened.kind === 'bundle') this.hooks.manifest(listed)
  }
}
