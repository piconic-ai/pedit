import { createHash, randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import { type Context, type Env, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { UpgradeWebSocket, WSContext } from 'hono/ws'
import { HeldError, NoPeditError } from './errors.ts'
import { nativeRealpath, nativeRealpathSync } from './paths.ts'
import { resolvePedit } from './resolve.ts'
import { ServedFiles } from './served.ts'
import type {
  CommentRange,
  CommentThread,
  Peer,
  Role,
  Shared,
  ShareOptions,
  ShareResult,
  ShareStatus,
  StartedThread,
} from './types.ts'

export type { Role }

export interface PeditOptions<E extends Env = Env> {
  /** From the adapter, created on the PARENT app (`createNodeWebSocket({ app })`). */
  upgradeWebSocket: UpgradeWebSocket
  /** realpath'd at startup; must exist. */
  root: string
  /** Exact origins of the integrator's pages; also used for the Host check. */
  origins: string[]
  app: string
  /** Map an id to a file under `root`. null is 404; throw an HTTPException for anything else. */
  resolve: (id: string, c: Context<E>) => Promise<{ path: string; role: Role } | null>
  /**
   * Absolute path to pedit; default: `pedit` on the PATH. Or a function that gives it, called when
   * a child is about to start, so a pedit installed while the app runs is used by the next one.
   * Config only.
   */
  bin?: string | (() => Promise<string>)
  idleMs?: number
  /** How long a child may take to exit after its input closed (default 5 s) before SIGTERM; on Windows it is given up on, never killed. */
  graceMs?: number
  /** Default false: refuse peers that are not on loopback. */
  allowRemote?: boolean
  onEvent?: (event: PeditEvent) => void
}

export type PeditEvent =
  | { type: 'started'; id: string; path: string; version?: string; serve?: number }
  | { type: 'stopped'; id: string; path: string; reason: 'idle' | 'exited' | 'shutdown' }
  | { type: 'error'; id: string | null; message: string }
  /** The room events: `id` is the one the routes last served the path under, or null. */
  | ({ type: 'shared'; id: string | null; path: string } & Omit<Shared, 'type'>)
  | { type: 'peers'; id: string | null; path: string; peers: Peer[]; more?: number }
  | { type: 'comments'; id: string | null; path: string; threads: CommentThread[]; more?: number }
  | { type: 'room_ended'; id: string | null; path: string; reason: string }
  | { type: 'unshared'; id: string | null; path: string }
  | { type: 'update_available'; version: string; url: string; security: boolean }

/** What `peditRoutes` adds to the Hono app. Paths are absolute and must be files under `root`. */
export interface PeditRoutes {
  /** Open a room for a file under `root`. The child stays up while it is shared. */
  share(path: string, opts?: ShareOptions): Promise<ShareResult>
  /** Leave the room: a kept room stays kept, a live one ends. */
  unshare(path: string): Promise<void>
  /** With a path: end that file's kept room for good. Without: stop every child. */
  close(path?: string): Promise<void>
  /** The file's room, shared now or kept without pedit; `null` when it has none. */
  status(path: string): Promise<ShareStatus | null>
  /** Change the keep of the room this file shares now (`3d`; not `0`). */
  keep(path: string, keep: string): Promise<ShareStatus>
  /** Start a thread on `[from, to)` of the text, as the host; only while the file is shared. */
  comment(path: string, range: CommentRange): Promise<StartedThread>
  /** Add a comment to a thread, as the host. */
  reply(path: string, thread: string, body: string): Promise<{ message: string }>
  /** Resolve a thread, or open it again, as the host. */
  resolve(path: string, thread: string, resolved: boolean): Promise<void>
}

const ID = /^[A-Za-z0-9_-]{1,128}$/
const TOKEN_TTL_MS = 60_000
const MAX_TOKENS = 1024
const RATE_PER_SECOND = 10
const MAX_PAGE_BUFFER = 16 * 1024 * 1024

/** True for 127.0.0.0/8, ::1 and their IPv4-mapped forms. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false
  const a = address.toLowerCase().replace(/^::ffff:/, '')
  return a === '::1' || /^127(\.\d{1,3}){3}$/.test(a)
}

function peerAddress(c: Context): string | undefined {
  const env = c.env as {
    incoming?: { socket?: { remoteAddress?: string } }
    requestIP?: (req: Request) => { address?: string } | null
  } | null
  return env?.incoming?.socket?.remoteAddress ?? env?.requestIP?.(c.req.raw)?.address
}

function validate(
  options: Pick<PeditOptions, 'upgradeWebSocket' | 'app' | 'origins' | 'root'> & {
    resolve: unknown
  },
): { root: string; hosts: Set<string>; origins: Set<string> } {
  if (typeof options.upgradeWebSocket !== 'function')
    throw new TypeError('upgradeWebSocket is required')
  if (typeof options.resolve !== 'function') throw new TypeError('resolve is required')
  if (!options.app) throw new TypeError('app must not be empty')
  if (!Array.isArray(options.origins) || options.origins.length === 0) {
    throw new TypeError('origins must list at least one origin')
  }
  const hosts = new Set<string>()
  for (const o of options.origins) {
    let url: URL
    try {
      url = new URL(o)
    } catch {
      throw new TypeError(`bad origin: ${o}`)
    }
    if (!/^https?:$/.test(url.protocol) || url.origin !== o) {
      throw new TypeError(`origins must be exact scheme://host[:port]: ${o}`)
    }
    hosts.add(url.host.toLowerCase())
  }
  let root: string
  try {
    root = nativeRealpathSync(options.root)
    if (!statSync(root).isDirectory()) throw new Error()
  } catch {
    throw new TypeError('root must be an existing directory')
  }
  return { root, hosts, origins: new Set(options.origins) }
}

/**
 * Component-wise: `root-private/x` is not under `root`. Both are native realpaths, so a prefix test
 * is exact. `path.relative` is not: on Windows it folds case, and `Root` and `root` can be two
 * directories (per-directory case sensitivity). Another drive or share is never a prefix.
 */
export function inside(root: string, path: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.length > prefix.length && path.startsWith(prefix)
}

interface Grant {
  id: string
  role: Role
  path: string
  generation: string
  expires: number
}

/** A bin function whose answer gets the checks of a string `bin`, and whose failure is a NoPeditError. */
function checkedBin(given: () => Promise<string>): () => Promise<string> {
  return async () => {
    let path: string
    try {
      path = await given()
    } catch (e) {
      if (e instanceof NoPeditError) throw e
      throw new NoPeditError(`pedit was not found: ${(e as Error)?.message}`)
    }
    return (await resolvePedit({ bin: path })).bin
  }
}

export function peditRoutes<E extends Env = Env>(options: PeditOptions<E>): Hono<E> & PeditRoutes {
  const { root, hosts, origins } = validate(options)
  const idByPath = new Map<string, string>()
  const emit = (event: PeditEvent) => {
    try {
      options.onEvent?.(event)
    } catch {}
  }
  let filesP: Promise<ServedFiles> | undefined
  // Resolved on first use, so a missing binary is a 503 and an event, not a crash at startup.
  const getFiles = () => {
    const { bin: given } = options
    filesP ??= (
      typeof given === 'function'
        ? Promise.resolve({ bin: checkedBin(given) })
        : resolvePedit({ bin: given })
    ).then(
      ({ bin }) =>
        new ServedFiles({
          bin,
          app: options.app,
          idleMs: options.idleMs,
          graceMs: options.graceMs,
          onEvent(e) {
            if (e.type === 'update_available') return emit(e)
            const id = (e.path !== null && idByPath.get(e.path)) || null
            if (e.type === 'error') emit({ type: 'error', id, message: e.message })
            else if (
              e.type === 'shared' ||
              e.type === 'peers' ||
              e.type === 'comments' ||
              e.type === 'room_ended' ||
              e.type === 'unshared'
            )
              emit({ ...e, id })
            else if (id !== null && (e.type === 'started' || e.type === 'stopped')) {
              emit(
                e.type === 'started'
                  ? {
                      type: 'started',
                      id,
                      path: e.path,
                      ...(e.version !== undefined && { version: e.version }),
                      ...(e.serve !== undefined && { serve: e.serve }),
                    }
                  : { type: 'stopped', id, path: e.path, reason: e.reason },
              )
            }
          },
        }),
      (e) => {
        filesP = undefined
        throw e
      },
    )
    return filesP
  }
  const tokens = new Map<string, Grant>()
  const hits = new Map<string, number[]>()

  const json = (c: Context, status: 400 | 403 | 404 | 409 | 429 | 500 | 503, error: string) =>
    c.json({ error }, status, { 'Cache-Control': 'no-store' })

  function rateLimited(key: string): boolean {
    const now = Date.now()
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (now - (v.at(-1) ?? 0) > 1000) hits.delete(k)
    }
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 1000)
    recent.push(now)
    hits.set(key, recent)
    return recent.length > RATE_PER_SECOND
  }

  async function lookup(id: string, c: Context<E>) {
    const found = await options.resolve(id, c)
    if (!found || (found.role !== 'edit' && found.role !== 'read')) return null
    if (typeof found.path !== 'string' || !isAbsolute(found.path)) return null
    try {
      const real = await nativeRealpath(found.path)
      if (!inside(root, real) || !(await stat(real)).isFile()) return null
      return { path: found.path, real, role: found.role }
    } catch {
      return null
    }
  }

  /** A path for the share API: under root, a regular file, as the routes' lookup demands. */
  async function sharable(path: string) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError('path must be absolute')
    let real: string
    try {
      real = await nativeRealpath(path)
      if (!inside(root, real) || !(await stat(real)).isFile()) throw new Error()
    } catch {
      throw new Error('file not found')
    }
    return (await getFiles()).acquire(real)
  }

  async function open(id: string, found: { real: string; role: Role }) {
    idByPath.set(found.real, id)
    return (await getFiles()).acquire(found.real)
  }

  const failure = (c: Context, e: unknown, role: Role, id: string) => {
    if (e instanceof HeldError && role === 'edit') return json(c, 409, 'held')
    if (!(e instanceof HeldError))
      emit({ type: 'error', id, message: String((e as Error)?.message) })
    return json(c, 503, 'busy')
  }

  const app = new Hono<E>()

  const guard = async (c: Context<E>, next: () => Promise<void>) => {
    const id = c.req.param('id' as never) as string | undefined
    if (!id || !ID.test(id)) return c.notFound()
    if (!hosts.has((c.req.header('host') ?? '').toLowerCase())) return c.notFound()
    if (!options.allowRemote && !isLoopback(peerAddress(c))) return json(c, 403, 'forbidden')
    await next()
  }
  app.use('/:id', guard)
  app.use('/:id/*', guard)

  app.post('/:id/session', async (c) => {
    const id = c.req.param('id')
    const origin = c.req.header('origin')
    const sameOrigin = c.req.header('sec-fetch-site') === 'same-origin'
    if (!(origin !== undefined && origins.has(origin)) && !sameOrigin) {
      return json(c, 403, 'forbidden')
    }
    const who = createHash('sha256')
      .update(c.req.header('cookie') ?? peerAddress(c) ?? '')
      .digest('hex')
    if (rateLimited(`${who}:${id}`)) return json(c, 429, 'rate')

    let found: Awaited<ReturnType<typeof lookup>>
    try {
      found = await lookup(id, c)
    } catch (e) {
      if (e instanceof HTTPException) throw e
      emit({ type: 'error', id, message: String((e as Error)?.message) })
      return json(c, 500, 'internal')
    }
    if (!found) return json(c, 404, 'not-found')
    let generation: string
    try {
      generation = (await open(id, found)).generation
    } catch (e) {
      return failure(c, e, found.role, id)
    }
    const now = Date.now()
    if (tokens.size >= MAX_TOKENS) {
      for (const [k, g] of tokens) if (g.expires <= now) tokens.delete(k)
      if (tokens.size >= MAX_TOKENS) return json(c, 429, 'rate')
    }
    const token = randomBytes(32).toString('hex')
    tokens.set(token, {
      id,
      role: found.role,
      path: found.path,
      generation,
      expires: now + TOKEN_TTL_MS,
    })
    return c.json({ token, role: found.role, generation }, 200, { 'Cache-Control': 'no-store' })
  })

  app.get('/:id/doc', async (c, next) => {
    const id = c.req.param('id')
    const origin = c.req.header('origin')
    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.notFound()
    if (origin === undefined || !origins.has(origin)) return json(c, 403, 'forbidden')
    // Get and delete before any await: a raced second upgrade finds nothing.
    const token = c.req.query('token') ?? ''
    const grant = tokens.get(token)
    tokens.delete(token)
    if (!grant || grant.id !== id || grant.expires <= Date.now()) return json(c, 403, 'forbidden')

    let found: Awaited<ReturnType<typeof lookup>>
    try {
      found = await lookup(id, c)
    } catch (e) {
      if (e instanceof HTTPException) throw e
      return json(c, 500, 'internal')
    }
    if (!found || found.role !== grant.role || found.path !== grant.path) {
      return json(c, 403, 'forbidden')
    }
    let bridge: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['dial']>>
    try {
      const served = await open(id, found)
      // The child may have restarted since the session: the page's copy is of another document.
      if (served.generation !== grant.generation) return json(c, 403, 'forbidden')
      bridge = await served.dial(found.role)
    } catch (e) {
      return failure(c, e, found.role, id)
    }
    // If the upgrade never completes, do not keep the slot.
    const abandoned = setTimeout(() => bridge.close(), 10_000)
    abandoned.unref()
    // The child can close while the browser's upgrade is pending: keep that and close the
    // browser as soon as it opens.
    let sock: WSContext | undefined
    let ended: { reason: string; code: number | undefined } | undefined
    const closeSock = (ws: WSContext, reason: string, code: number | undefined) => {
      const ok = code !== undefined && (code === 1000 || (code >= 3000 && code < 5000))
      if (ok) ws.close(code, Buffer.from(reason).subarray(0, 120).toString())
      // The child is gone: the page re-issues a session and compares generations.
      else ws.close(4001, 'document restarted')
    }
    bridge.onclose = (reason, code) => {
      ended = { reason, code }
      clearTimeout(abandoned)
      if (sock) closeSock(sock, reason, code)
    }
    const upgrade = options.upgradeWebSocket(() => ({
      onOpen(_evt, ws) {
        clearTimeout(abandoned)
        if (ended) return closeSock(ws, ended.reason, ended.code)
        sock = ws
        bridge.onframe = (frame) => {
          const raw = ws.raw as { bufferedAmount?: number } | undefined
          if ((raw?.bufferedAmount ?? 0) > MAX_PAGE_BUFFER) return ws.close(1013, 'too slow')
          ws.send(frame as Uint8Array<ArrayBuffer>)
        }
      },
      onMessage(evt, ws) {
        if (typeof evt.data === 'string') return ws.close(1003, 'binary frames only')
        if (evt.data instanceof ArrayBuffer) bridge.send(new Uint8Array(evt.data))
      },
      onClose() {
        clearTimeout(abandoned)
        bridge.close()
      },
    }))
    return upgrade(c, next)
  })

  app.notFound((c) => c.body(null, 404))

  return Object.assign(app, {
    /** Open a room for a file under `root`. The child stays up while it is shared. */
    share: async (path: string, opts?: ShareOptions): Promise<ShareResult> =>
      (await sharable(path)).share(opts),
    unshare: async (path: string) => (await sharable(path)).unshare(),
    /** With a path: end that file's kept room for good. Without: stop every child. */
    close: async (path?: string): Promise<void> => {
      if (path !== undefined) return (await sharable(path)).close()
      await (await filesP?.catch(() => undefined))?.close()
    },
    status: async (path: string) => (await sharable(path)).status(),
    keep: async (path: string, keep: string) => (await sharable(path)).keep(keep),
    comment: async (path: string, range: CommentRange) => (await sharable(path)).comment(range),
    reply: async (path: string, thread: string, body: string) =>
      (await sharable(path)).reply(thread, body),
    resolve: async (path: string, thread: string, resolved: boolean) =>
      (await sharable(path)).resolve(thread, resolved),
  })
}
