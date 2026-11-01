import { type ChildProcess, spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute } from 'node:path'
import { type Bridge, dialSocket } from './bridge.ts'
import { HeldError, LimitError, NoPeditError } from './errors.ts'
import { peditEnv } from './resolve.ts'
import type { Role, ServeEvent } from './types.ts'

const MAX_FILES = 32
const MAX_CLIENTS = 8
const MAX_LINE = 4096
const STDERR_KEEP = 1024
const TERM_AFTER_MS = 5000

export interface ServedFilesOptions {
  bin: string
  /** Shown by another pedit's refusal. */
  app: string
  /** Stop the child this long after the last client left. Default 60 s. */
  idleMs?: number
  /** This layer knows paths, not IDs. */
  onEvent?: (event: ServeEvent) => void
}

export interface ServedFile {
  readonly path: string
  /** One connection to the child's socket; at most 8 per file (LimitError). */
  dial(role: Role): Promise<Bridge>
}

interface Entry {
  path: string
  ino: string
  child: ChildProcess
  ready: Promise<string>
  socket: string | undefined
  clients: number
  idle: NodeJS.Timeout | undefined
  stopping: 'idle' | 'shutdown' | undefined
  exited: Promise<void>
  dead: boolean
  handle: ServedFile
}

export class ServedFiles {
  #options: ServedFilesOptions
  #byPath = new Map<string, Entry>()
  #byIno = new Map<string, Entry>()
  #closed = false

  constructor(options: ServedFilesOptions) {
    if (process.platform === 'win32') throw new Error('@pedit/serve does not support Windows')
    if (!isAbsolute(options.bin)) throw new TypeError('bin must be an absolute path')
    if (!options.app) throw new TypeError('app is required')
    this.#options = options
  }

  /**
   * Start or reuse the child serving `path` (absolute). Keyed by realpath and dev:ino, so a hard
   * link or a case variant of one file never gets two children.
   */
  async acquire(path: string): Promise<ServedFile> {
    if (!isAbsolute(path)) throw new TypeError('path must be absolute')
    const real = await realpath(path)
    const st = await stat(real)
    if (!st.isFile()) throw new Error('not a regular file')
    const ino = `${st.dev}:${st.ino}`
    for (;;) {
      if (this.#closed) throw new Error('ServedFiles is closed')
      let entry = this.#byIno.get(ino) ?? this.#byPath.get(real)
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

  /** End every child: close stdin, wait, SIGTERM after 5 s. Never SIGKILL inside the write delay. */
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
        '--root',
        dirname(path),
        '--json',
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
    let onReady!: (socket: string) => void
    let onFail!: (e: Error) => void
    const ready = new Promise<string>((res, rej) => {
      onReady = res
      onFail = rej
    })
    ready.catch(() => {}) // a rejection nobody awaits is not an unhandled one
    const entry: Entry = {
      path,
      ino,
      child,
      ready,
      socket: undefined,
      clients: 0,
      idle: undefined,
      stopping: undefined,
      exited,
      dead: false,
      handle: {
        path,
        dial: (role) => this.#dial(entry, role),
      },
    }
    this.#byPath.set(path, entry)
    this.#byIno.set(ino, entry)

    let held: { pid: number; app?: string } | undefined
    let errorMessage: string | undefined
    let missing = false
    let stderr = ''
    let buf = ''
    child.stdin.on('error', () => {})
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d: string) => {
      if (stderr.length < STDERR_KEEP) stderr = (stderr + d).slice(0, STDERR_KEEP)
    })
    const onLine = (line: string) => {
      let ev: Record<string, unknown>
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.event === 'listening' && typeof ev.socket === 'string' && !entry.socket) {
        entry.socket = ev.socket
        this.#emit({ type: 'started', path })
        this.#armIdle(entry)
        onReady(ev.socket)
      } else if (ev.event === 'held') {
        held = { pid: Number(ev.pid), ...(typeof ev.app === 'string' ? { app: ev.app } : {}) }
      } else if (ev.event === 'error' && typeof ev.message === 'string') {
        errorMessage = ev.message.slice(0, STDERR_KEEP)
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      buf += d
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.length > MAX_LINE) return child.kill('SIGTERM')
        onLine(line)
      }
      if (buf.length > MAX_LINE) child.kill('SIGTERM')
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') missing = true
      else errorMessage = e.message
    })
    child.on('close', (code) => {
      entry.dead = true
      clearTimeout(entry.idle)
      if (this.#byPath.get(path) === entry) this.#byPath.delete(path)
      if (this.#byIno.get(ino) === entry) this.#byIno.delete(ino)
      if (!entry.socket) {
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
    setTimeout(() => entry.dead || entry.child.kill('SIGTERM'), TERM_AFTER_MS).unref()
  }

  async #dial(entry: Entry, role: Role): Promise<Bridge> {
    if (entry.dead || entry.stopping || !entry.socket)
      throw new Error('the file is no longer served')
    if (entry.clients >= MAX_CLIENTS) throw new LimitError('too many clients for this file')
    entry.clients++
    clearTimeout(entry.idle)
    const release = () => {
      entry.clients--
      this.#armIdle(entry)
    }
    try {
      return await dialSocket(entry.socket, role, release)
    } catch (e) {
      release()
      throw e
    }
  }
}
