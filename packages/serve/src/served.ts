import { type ChildProcess, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute } from 'node:path'
import { type Bridge, EVENT, FrameParser, Streams } from './bridge.ts'
import { HeldError, LimitError, NoPeditError } from './errors.ts'
import { nativeRealpath } from './paths.ts'
import { peditEnv } from './resolve.ts'
import type { Role, ServeEvent } from './types.ts'

const MAX_FILES = 32
const MAX_CLIENTS = 8
const MAX_EVENT = 4096
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
  /** This layer knows paths, not IDs. */
  onEvent?: (event: ServeEvent) => void
}

export interface ServedFile {
  readonly path: string
  /** Names the document: the same after a restart that restored it, new when it started afresh. */
  readonly generation: string
  /** One stream to the child; at most 8 per file (LimitError). */
  dial(role: Role): Promise<Bridge>
}

interface Entry {
  path: string
  ino: string
  child: ChildProcess
  ready: Promise<void>
  streams: Streams
  listening: boolean
  generation: string
  clients: number
  idle: NodeJS.Timeout | undefined
  stopping: 'idle' | 'shutdown' | undefined
  exited: Promise<void>
  dead: boolean
  /** Forget a child that did not exit (Windows, where it is never killed). */
  giveUp: () => void
  handle: ServedFile
}

const WIN = process.platform === 'win32'

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

export class ServedFiles {
  #options: ServedFilesOptions
  #byPath = new Map<string, Entry>()
  #byIno = new Map<string, Entry>()
  #closed = false

  constructor(options: ServedFilesOptions) {
    if (!isAbsolute(options.bin)) throw new TypeError('bin must be an absolute path')
    if (!options.app) throw new TypeError('app is required')
    this.#options = options
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
      generation: '',
      clients: 0,
      idle: undefined,
      stopping: undefined,
      exited,
      dead: false,
      giveUp: () => {
        if (entry.dead) return
        entry.dead = true
        const message = 'pedit did not exit after its input was closed'
        this.#emit({ type: 'error', path, message })
        entry.streams.abort()
        clearTimeout(entry.idle)
        if (this.#byPath.get(path) === entry) this.#byPath.delete(path)
        if (this.#byIno.get(entry.ino) === entry) this.#byIno.delete(entry.ino)
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
    const onEvent = (payload: Buffer) => {
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(payload.toString())
      } catch {
        return
      }
      if (ev.event === 'listening' && !entry.listening) {
        if (typeof ev.generation !== 'string' || ev.generation === '') {
          errorMessage = 'pedit did not report a generation; it is too old'
          return this.#terminate(entry)
        }
        entry.listening = true
        entry.generation = ev.generation
        this.#emit({ type: 'started', path })
        this.#armIdle(entry)
        onReady()
      } else if (ev.event === 'held') {
        held = { pid: Number(ev.pid), ...(typeof ev.app === 'string' ? { app: ev.app } : {}) }
      } else if (ev.event === 'error' && typeof ev.message === 'string') {
        errorMessage = ev.message.slice(0, STDERR_KEEP)
      }
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
      entry.streams.abort()
      clearTimeout(entry.idle)
      if (this.#byPath.get(path) === entry) this.#byPath.delete(path)
      if (this.#byIno.get(entry.ino) === entry) this.#byIno.delete(entry.ino)
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

  #armIdle(entry: Entry) {
    clearTimeout(entry.idle)
    if (entry.clients > 0 || entry.dead || entry.stopping) return
    entry.idle = setTimeout(() => this.#stop(entry, 'idle'), this.#options.idleMs ?? 60_000)
    entry.idle.unref()
  }

  #stop(entry: Entry, reason: 'idle' | 'shutdown') {
    if (entry.stopping || entry.dead) return
    entry.stopping = reason
    clearTimeout(entry.idle)
    entry.child.stdin?.end()
    // Saving takes a write delay: ask nicely first, and never SIGKILL.
    const overdue = () => (WIN ? entry.giveUp() : entry.child.kill('SIGTERM'))
    setTimeout(() => entry.dead || overdue(), this.#options.graceMs ?? TERM_AFTER_MS).unref()
  }

  /** Ask the child to end after it did not in time, or broke the protocol. */
  #terminate(entry: Entry) {
    if (!WIN) return void entry.child.kill('SIGTERM')
    // Windows: closing stdin is the only stop. Wait once more, then give up without killing.
    entry.child.stdin?.end()
    setTimeout(() => entry.dead || entry.giveUp(), this.#options.graceMs ?? TERM_AFTER_MS).unref()
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
