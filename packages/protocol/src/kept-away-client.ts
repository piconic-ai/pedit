import * as Y from 'yjs'
import type { RoomKeys } from './access.ts'
import { type FileEntry, metaTarget } from './files.ts'
import {
  declare,
  decodeSnapshot,
  decodeUpdate,
  incomplete,
  openKeptFrame,
  probeEntries,
  sealKeptUpdate,
  trial,
} from './kept-text.ts'
import { decodeLogged, decodeUint64, Kind } from './kinds.ts'

/** Whether an edit was kept by the relay yet: sent and not acknowledged, or all acknowledged. */
export type KeptSync = 'pending' | 'kept'

/** What the client of a room needs from its docs and its owner. */
export interface KeptHooks {
  /** The doc followed as this file, and whether it holds a file's comments. */
  docOf(id: number): { doc: Y.Doc; comments: boolean } | undefined
  /** The files the host's snapshot lists. */
  manifest(files: FileEntry[]): void
  sync(state: KeptSync): void
  /** How many entries and snapshots did not hold, in all. */
  skipped(count: number): void
}

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * The browser's side of a room kept while its host is away
 * (docs/design/rooms-away.md): edits go to the relay as signed, encrypted
 * entries (the kept-text format), and what the relay logged is applied with
 * the kept-text checks. An entry is pending until the relay sends it back
 * with an id, which acknowledges it.
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
  private pending: Uint8Array[] = []
  // Per file, the snapshot and the entries after it, for a doc added later.
  private backlog = new Map<number, Uint8Array[]>()
  private files: FileEntry[] | undefined

  constructor(
    private readonly keys: RoomKeys,
    private readonly origin: unknown,
    private readonly hooks: KeptHooks,
  ) {}

  /** Seals an update of a doc as an entry, held until the relay logs it. */
  async entry(id: number, update: Uint8Array): Promise<Uint8Array> {
    const body = await sealKeptUpdate(this.keys, id, update)
    this.pending.push(body)
    this.hooks.sync('pending')
    return body
  }

  /** How many entries the relay has not acknowledged. */
  get held(): number {
    return this.pending.length
  }

  /** The entries the relay has not acknowledged, to send again. */
  unacknowledged(): Uint8Array[] {
    return [...this.pending]
  }

  /** Lets go of what is pending: the room is live and the host takes the state. */
  settle(): void {
    this.active = false
    this.backlog.clear()
    if (this.pending.length > 0) {
      this.pending = []
      this.hooks.sync('kept')
    }
  }

  /** Brings a doc added after the replay up to date with it. */
  adopt(id: number, doc: Y.Doc, comments: boolean): void {
    const updates = this.backlog.get(id)
    if (!updates) return
    declare(doc, comments)
    const result = probeEntries(doc, updates)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(result.doc), this.origin)
    result.doc.destroy()
    this.skip(result.skipped)
  }

  /** Takes a message of kind 1, 4, 5 or 6 from the relay. */
  async receive(kind: number, payload: Uint8Array): Promise<void> {
    try {
      if (kind === Kind.Replay) await this.snapshot(payload)
      else if (kind === Kind.LogEnd) this.logEnd(decodeUint64(payload))
      else if (kind === Kind.Logged) await this.logged(payload)
      else if (kind === Kind.Entry) await this.take(payload)
    } catch {
      this.skip(1)
    }
  }

  private skip(count: number): void {
    if (count === 0) return
    this.skipped += count
    this.hooks.skipped(this.skipped)
  }

  private logEnd(tail: number | undefined): void {
    if (tail !== undefined) this.after = Math.max(this.after ?? 0, tail)
  }

  private async logged(payload: Uint8Array): Promise<void> {
    const logged = decodeLogged(payload)
    if (!logged) throw new Error('invalid logged entry')
    this.after = Math.max(this.after ?? 0, logged.id)
    const mine = this.pending.findIndex((body) => same(body, logged.entry))
    if (mine < 0) return this.take(logged.entry)
    this.pending.splice(mine, 1)
    if (this.pending.length === 0) this.hooks.sync('kept')
  }

  // An entry some editor wrote: applied if it holds, else left out and counted.
  private async take(entry: Uint8Array): Promise<void> {
    const { id, update } = decodeUpdate(await openKeptFrame(this.keys, entry))
    if (this.files && !this.files.some((file) => file.id === id)) throw new Error('unknown file')
    this.backlog.set(id, [...(this.backlog.get(id) ?? []), update])
    this.apply(id, update)
  }

  private apply(id: number, update: Uint8Array): void {
    const target = this.hooks.docOf(id)
    if (!target) return
    try {
      declare(target.doc, target.comments)
      const probe = trial(target.doc, update)
      const missing = incomplete(probe)
      probe.destroy()
      if (missing) throw new Error('incomplete kept update')
      Y.applyUpdate(target.doc, update, this.origin)
    } catch {
      this.skip(1)
    }
  }

  // The host's snapshot of every file: the start of the docs, and the files they are.
  private async snapshot(bundle: Uint8Array): Promise<void> {
    const opened = decodeSnapshot(await openKeptFrame(this.keys, bundle))
    const files =
      opened.kind === 'bundle' ? opened.files : [{ id: 0, path: '', update: opened.update }]
    this.backlog = new Map(files.map((file) => [file.id, [file.update]]))
    for (const file of files) this.apply(file.id, file.update)
    if (opened.kind !== 'bundle') return
    // A file whose path is the metadata path of another is that file's comments.
    const paths = new Set(files.map((file) => file.path))
    const listed = files.map(({ id, path }) => {
      const target = metaTarget(path)
      return { id, path, format: target !== undefined && paths.has(target) ? 'meta' : 'text' }
    })
    if (JSON.stringify(listed) === JSON.stringify(this.files)) return
    this.files = listed
    this.hooks.manifest(listed)
  }
}
