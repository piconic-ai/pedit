import { type ChildProcess, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute } from 'node:path'
import { type Bridge, EVENT, FrameParser, MAX_COMMAND, Streams } from './bridge.ts'
import { HeldError, LimitError, NoPeditError } from './errors.ts'
import { nativeRealpath } from './paths.ts'
import { peditEnv } from './resolve.ts'
import type { Peer, Role, ServeEvent, Shared, ShareOptions, ShareResult } from './types.ts'

const MAX_FILES = 32
const MAX_CLIENTS = 8
const MAX_EVENT = 64 * 1024
const MAX_PENDING = 16
/** The first serve version that takes commands. */
const SHARE_SERVE = 2
const STDERR_KEEP = 1024
const TERM_AFTER_MS = 5000

export interface ServedFilesOptions {
  bin: string
  /** Shown by another pedit's refusal. */
  app: string
  /** Stop the child this long after the last client left. Default 60 s. */
  idleMs?: number
  /** How long a child may take to exit after stdin closed, before SIGTERM (Windows: before it is given up on). Default 5 s. */
  graceMs?: number
  /** Tests only: behave as this platform (Windows never signals a child). */
  platform?: NodeJS.Platform
  /** This layer knows paths, not IDs. */
  onEvent?: (event: ServeEvent) => void
}

export interface ServedFile {
  readonly path: string
  /** Names the document: the same after a restart that restored it, new when it started afresh. */
  readonly generation: string
  /** One stream to the child; at most 8 per file (LimitError). */
  dial(role: Role): Promise<Bridge>
  /**
   * Open a room for the file (serve >= 2). Resolves with the links, or with a `choice` when the
   * file has a kept room of another history; rejects with pedit's error. While shared, the child
   * is not stopped for idleness.
   */
  share(options?: ShareOptions): Promise<ShareResult>
  /** Leave the room: a kept room stays kept, a live one ends. */
  unshare(): Promise<void>
  /** End the file's kept room for good (a live one is only left). Resolves once it is over. */
  close(): Promise<void>
}

type Cmd = 'share' | 'unshare' | 'close'

/** A command waiting for pedit's answer: the event that carries its id. */
interface Pending {
  id: string
  cmd: Cmd
  resolve: (event: Record<string, unknown>) => void
  reject: (e: Error) => void
}

interface Entry {
  path: string
  ino: string
  child: ChildProcess
  ready: Promise<void>
  streams: Streams
  listening: boolean
  /** The `serve` version of pedit's interface; 0 when it did not say. */
  serve: number
  /** A room is open, so reviewers may be in it with no app page. */
  shared: boolean
  pending: Pending[]
  /** Numbers the command ids. */
  commands: number
  generation: string
  clients: number
  idle: NodeJS.Timeout | undefined
  stopping: 'idle' | 'shutdown' | undefined
  exited: Promise<void>
  dead: boolean
  /** Windows: the child did not exit and was left running; it stays indexed until it does. */
  givenUp: boolean
  /** Forget a child that did not exit (Windows, where it is never killed). */
  giveUp: () => void
  handle: ServedFile
}

/**
 * `dev:ino`, or '' when the file system gives no inode (Node reports 0 on FAT and some shares):
 * different files would look like one, so an empty id is never used to alias. bigint keeps the
 * 64-bit file ids of NTFS exact.
 */
async function inodeOf(real: string): Promise<string> {
  const st = await stat(real, { bigint: true })
  if (!st.isFile()) throw new Error('not a regular file')
  return st.ino === 0n ? '' : `${st.dev}:${st.ino}`
}

function sharedOf(ev: Record<string, unknown>): Shared {
  const links = (ev.links ?? {}) as Shared['links']
  return {
    type: 'shared',
    room: String(ev.room),
    links: { edit: links.edit, read: links.read, ...(links.comment && { comment: links.comment }) },
    keptUntil: Number(ev.keptUntil) || 0,
    resumed: ev.resumed === true,
  }
}

export class ServedFiles {
  #options: ServedFilesOptions
  #byPath = new Map<string, Entry>()
  #byIno = new Map<string, Entry>()
  #closed = false
  #win: boolean

  constructor(options: ServedFilesOptions) {
    if (!isAbsolute(options.bin)) throw new TypeError('bin must be an absolute path')
    if (!options.app) throw new TypeError('app is required')
    this.#options = options
    this.#win = (options.platform ?? process.platform) === 'win32'
  }

  /**
   * Start or reuse the child serving `path` (absolute). Keyed by the native realpath (never case
   * folded: on Windows two names that differ in case can be two files) and dev:ino, so a hard link
   * or another spelling of one file never gets two children.
   */
  async acquire(path: string): Promise<ServedFile> {
    if (!isAbsolute(path)) throw new TypeError('path must be absolute')
    for (;;) {
      if (this.#closed) throw new Error('ServedFiles is closed')
      const real = await nativeRealpath(path)
      const ino = await inodeOf(real)
      const alias = await this.#aliasFor(real, ino)
      if (this.#closed) throw new Error('ServedFiles is closed')
      let entry = this.#byPath.get(real) ?? alias
      if (entry && entry.ino !== ino && entry.path === real) this.#reindex(entry, ino)
      // A child that was given up on still runs and holds the file: a second one would be refused.
      if (entry?.givenUp) throw new HeldError({ pid: entry.child.pid ?? 0 })
      if (entry?.stopping) {
        await entry.exited
        continue
      }
      if (!entry) {
        if (this.#byPath.size >= MAX_FILES) throw new LimitError('too many served files')
        entry = this.#start(real, ino)
      }
      await entry.ready
      return entry.handle
    }
  }

  /**
   * The entry that already serves this file under another name. An inode alias counts only while
   * the other path still has that inode: an atomic save gives the served path a new one and splits
   * a hard link into two files. No inode (''), no alias.
   */
  async #aliasFor(real: string, ino: string): Promise<Entry | undefined> {
    const alias = ino === '' ? undefined : this.#byIno.get(ino)
    if (alias === undefined || alias.path === real) return undefined
    return (await inodeOf(alias.path).catch(() => '')) === ino ? alias : undefined
  }

  #reindex(entry: Entry, ino: string) {
    if (this.#byIno.get(entry.ino) === entry) this.#byIno.delete(entry.ino)
    entry.ino = ino
    if (ino !== '') this.#byIno.set(ino, entry)
  }

  /**
   * End every child: close stdin, wait, SIGTERM after 5 s. Never SIGKILL inside the write delay.
   * On Windows there is no SIGTERM (it is TerminateProcess), so stdin only: a child that does not
   * exit is reported and given up on, not killed.
   */
  async close(): Promise<void> {
    this.#closed = true
    const entries = [...this.#byPath.values()]
    for (const e of entries) this.#stop(e, 'shutdown')
    await Promise.all(entries.map((e) => e.exited))
  }

  /** The last update_available version passed on: every child reports the same release. */
  #updateSeen: string | undefined

  #emit(event: ServeEvent) {
    try {
      this.#options.onEvent?.(event)
    } catch {}
  }

  #start(path: string, ino: string): Entry {
    const child = spawn(
      this.#options.bin,
      [
        'serve',
        '--stdio',
        '--root',
        dirname(path),
        '--app',
        this.#options.app,
        '--',
        basename(path),
      ],
      { env: peditEnv(), cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], shell: false },
    )
    let onExit!: () => void
    const exited = new Promise<void>((r) => {
      onExit = r
    })
    let onReady!: () => void
    let onFail!: (e: Error) => void
    const ready = new Promise<void>((res, rej) => {
      onReady = res
      onFail = rej
    })
    ready.catch(() => {}) // a rejection nobody awaits is not an unhandled one
    const entry: Entry = {
      path,
      ino,
      child,
      ready,
      streams: new Streams(child.stdin),
      listening: false,
      serve: 0,
      shared: false,
      pending: [],
      commands: 0,
      generation: '',
      clients: 0,
      idle: undefined,
      stopping: undefined,
      exited,
      dead: false,
      givenUp: false,
      giveUp: () => {
        if (entry.dead) return
        entry.dead = true
        entry.givenUp = true // stays in the indexes (and counts) until it really exits
        const message = 'pedit did not exit after its input was closed'
        this.#emit({ type: 'error', path, message })
        entry.streams.abort()
        clearTimeout(entry.idle)
        // Let the host exit without waiting for a child it will not kill.
        child.unref()
        for (const s of [child.stdin, child.stdout, child.stderr]) (s as Socket | null)?.unref?.()
        onFail(new Error(message))
        onExit()
      },
      handle: {
        path,
        get generation() {
          return entry.generation
        },
        dial: (role) => this.#dial(entry, role),
        share: async (options) => {
          const { choice, keep, origins, relay } = options ?? {}
          const ev = await this.#command(entry, 'share', { origins, keep, relay, choice })
          if (ev.event === 'resume_choice')
            return { type: 'choice', room: String(ev.room), choices: ev.choices } as ShareResult
          if (ev.event === 'room_ended') return { type: 'closed' } // choice "app" ended the room
          return sharedOf(ev)
        },
        unshare: async () => void (await this.#command(entry, 'unshare')),
        close: async () => void (await this.#command(entry, 'close')),
      },
    }
    this.#byPath.set(path, entry)
    if (ino !== '') this.#byIno.set(ino, entry)

    let held: { pid: number; app?: string } | undefined
    let errorMessage: string | undefined
    let missing = false
    let stderr = ''
    const parser = new FrameParser()
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      if (stderr.length < STDERR_KEEP) stderr = (stderr + d).slice(0, STDERR_KEEP)
    })
    const emitRoom = (ev: Record<string, unknown>, event: ServeEvent) => {
      this.#answer(entry, ev) // before any callback: a reentrant command must not be taken for it
      this.#emit(event)
    }
    const handlers: Record<string, (ev: Record<string, unknown>) => void> = {
      listening: (ev) => {
        if (entry.listening) return
        if (typeof ev.generation !== 'string' || ev.generation === '') {
          errorMessage = 'pedit did not report a generation; it is too old'
          return this.#terminate(entry)
        }
        entry.listening = true
        entry.serve = typeof ev.serve === 'number' ? ev.serve : 0
        entry.generation = ev.generation
        this.#emit({
          type: 'started',
          path,
          ...(typeof ev.version === 'string' && { version: ev.version }),
          ...(typeof ev.serve === 'number' && { serve: ev.serve }),
        })
        this.#armIdle(entry)
        onReady()
      },
      update_available: (ev) => {
        const { version, url, security } = ev
        if (typeof version !== 'string' || typeof url !== 'string' || version === this.#updateSeen)
          return
        this.#updateSeen = version
        this.#emit({
          type: 'update_available',
          version: version.slice(0, 64),
          url: url.slice(0, 512),
          security: security === true,
        })
      },
      held: (ev) => {
        held = { pid: Number(ev.pid), ...(typeof ev.app === 'string' ? { app: ev.app } : {}) }
      },
      error: (ev) => {
        if (typeof ev.message !== 'string') return
        errorMessage = ev.message.slice(0, STDERR_KEEP)
        this.#answer(entry, ev)
      },
      shared: (ev) => {
        entry.shared = true
        clearTimeout(entry.idle)
        emitRoom(ev, { path, ...sharedOf(ev) })
      },
      resume_choice: (ev) => this.#answer(entry, ev),
      unshared: (ev) => {
        this.#left(entry)
        emitRoom(ev, { type: 'unshared', path })
      },
      room_ended: (ev) => {
        this.#left(entry)
        emitRoom(ev, { type: 'room_ended', path, reason: String(ev.reason).slice(0, 64) })
      },
      peers: (ev) => {
        if (!Array.isArray(ev.peers)) return
        const peers = ev.peers.map(
          (p: Peer): Peer => ({ name: String(p?.name), access: p?.access }),
        )
        this.#emit({
          type: 'peers',
          path,
          peers,
          ...(typeof ev.more === 'number' && { more: ev.more }),
        })
      },
    }
    const onEvent = (payload: Buffer) => {
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(payload.toString())
      } catch {
        return
      }
      const name = String(ev?.event)
      if (Object.hasOwn(handlers, name)) handlers[name]?.(ev)
    }
    let broken = false
    const frameBroke = () => {
      broken = true
      this.#terminate(entry)
    }
    child.stdout.on('data', (d: Buffer) => {
      if (broken) return
      for (const f of parser.push(d)) {
        if (f.kind !== EVENT) entry.streams.deliver(f)
        else if (f.stream !== 0 || f.payload.length > MAX_EVENT) return frameBroke()
        else onEvent(f.payload)
      }
      if (parser.error) frameBroke()
    })
    child.stdout.on('error', () => {})
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') missing = true
      else errorMessage = e.message
    })
    child.on('close', (code) => {
      entry.dead = true
      this.#forget(entry)
      if (entry.givenUp) return // already reported; its events must not reach a newer child's id
      if (!entry.listening) {
        if (missing) onFail(new NoPeditError('the pedit binary cannot be run'))
        else if (code === 3 && held) onFail(new HeldError(held))
        else onFail(new Error(errorMessage ?? (stderr.trim() || `pedit exited with code ${code}`)))
        if (!held) this.#emit({ type: 'error', path, message: String(errorMessage ?? stderr) })
      } else {
        if (stderr.trim() && code !== 0) this.#emit({ type: 'error', path, message: stderr })
        this.#emit({ type: 'stopped', path, reason: entry.stopping ?? 'exited' })
      }
      onExit()
    })
    return entry
  }

  /** Drop an exited entry from the indexes and end what hangs off it. */
  #forget(entry: Entry) {
    entry.streams.abort()
    for (const p of entry.pending.splice(0)) p.reject(new Error('the file is no longer served'))
    clearTimeout(entry.idle)
    if (this.#byPath.get(entry.path) === entry) this.#byPath.delete(entry.path)
    if (this.#byIno.get(entry.ino) === entry) this.#byIno.delete(entry.ino)
  }

  /** Run `overdue` if the child is still alive after the grace period. */
  #grace(entry: Entry, overdue: () => void) {
    setTimeout(() => entry.dead || overdue(), this.#options.graceMs ?? TERM_AFTER_MS).unref()
  }

  /**
   * Send a command with an id of its own; only the event that carries that id answers it. The
   * idle stop waits while a command is pending.
   */
  #command(entry: Entry, cmd: Cmd, fields: object = {}): Promise<Record<string, unknown>> {
    if (entry.dead || entry.stopping || !entry.listening)
      return Promise.reject(new Error('the file is no longer served'))
    if (entry.serve < SHARE_SERVE)
      return Promise.reject(
        new Error(`sharing needs pedit serve ${SHARE_SERVE}; this pedit is older`),
      )
    if (entry.pending.length >= MAX_PENDING)
      return Promise.reject(new LimitError('too many commands'))
    const id = `c${++entry.commands}`
    const json = JSON.stringify({ cmd, id, ...fields })
    if (Buffer.byteLength(json) > MAX_COMMAND) return Promise.reject(new Error('command too large'))
    return new Promise((resolve, reject) => {
      clearTimeout(entry.idle)
      entry.pending.push({ id, cmd, resolve, reject })
      entry.streams.command(json)
    })
  }

  /** Settle the command `ev` answers, by its id; an event without one answers nothing. */
  #answer(entry: Entry, ev: Record<string, unknown>) {
    const i = entry.pending.findIndex((p) => p.id === ev.id)
    if (i < 0) return
    const [done] = entry.pending.splice(i, 1) as [Pending]
    if (ev.event === 'error') done.reject(new Error(String(ev.message).slice(0, STDERR_KEEP)))
    else done.resolve(ev)
    this.#armIdle(entry) // once the queue is empty, with no client and no room, the child may idle out
  }

  /** The room is gone: the child may idle out again. */
  #left(entry: Entry) {
    entry.shared = false
    this.#armIdle(entry)
  }

  #armIdle(entry: Entry) {
    clearTimeout(entry.idle)
    if (
      entry.clients > 0 ||
      entry.shared ||
      entry.pending.length > 0 ||
      entry.dead ||
      entry.stopping
    )
      return
    entry.idle = setTimeout(() => this.#stop(entry, 'idle'), this.#options.idleMs ?? 60_000)
    entry.idle.unref()
  }

  #stop(entry: Entry, reason: 'idle' | 'shutdown') {
    if (entry.stopping || entry.dead) return
    entry.stopping = reason
    clearTimeout(entry.idle)
    entry.child.stdin?.end()
    // Saving takes a write delay: ask nicely first, and never SIGKILL.
    this.#grace(entry, () => (this.#win ? entry.giveUp() : entry.child.kill('SIGTERM')))
  }

  /** Ask the child to end after it did not in time, or broke the protocol. */
  #terminate(entry: Entry) {
    if (!this.#win) return void entry.child.kill('SIGTERM')
    // Windows: closing stdin is the only stop. Wait once more, then give up without killing.
    entry.child.stdin?.end()
    this.#grace(entry, () => entry.giveUp())
  }

  async #dial(entry: Entry, role: Role): Promise<Bridge> {
    if (entry.dead || entry.stopping || !entry.listening)
      throw new Error('the file is no longer served')
    if (entry.clients >= MAX_CLIENTS) throw new LimitError('too many clients for this file')
    entry.clients++
    clearTimeout(entry.idle)
    const release = () => {
      entry.clients--
      this.#armIdle(entry)
    }
    try {
      return entry.streams.open(role, release)
    } catch (e) {
      release()
      throw e
    }
  }
}
