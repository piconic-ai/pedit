import { checkProtocolVersion } from '@pedit/protocol/admission'
import { RELAY_BUSY, RELAY_MAINTENANCE } from '@pedit/protocol/close'
import { Hono } from 'hono'
import { scheduledKeptSweep } from './kept-scheduled.ts'

export { KeptSweepShard } from './kept-sweep-shard.ts'

import { embedSourcesFor, mediaSourcesFrom, scriptHashes, servePage } from './page.ts'
import { HOST_HEADER, maintenance, refuse } from './room.ts'
import { roomIdFor } from './room-identity.ts'

export { maintenance, Room } from './room.ts'
export { embedSourcesFor, mediaSourcesFrom, roomIdFor, scriptHashes, servePage }

// Room ids are 128+ bits, base64url without padding.
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/
// Blob ids are 128-bit HMACs, base64url without padding.
const BLOB_ID = /^[A-Za-z0-9_-]{22}$/

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Whether a request may open a room's WebSocket. WebSockets are exempt from
 * the same-origin policy, so without this any website could have its
 * visitors' browsers use the relay. Browsers always send Origin and pages
 * cannot forge it; the CLI sends none and is let in.
 */
export function allowedOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  return origin === null || origin === new URL(request.url).origin
}

/**
 * The key a client is counted under in rate limits: its IP address, or for
 * IPv6 the /64 it is in, since one network gets a whole /64 and can pick any
 * address in it.
 */
export function clientKey(request: Request): string {
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip) return 'unknown'
  if (!ip.includes(':')) return ip
  const [head = '', tail] = ip.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`
}

/**
 * Whether the client is over a rate limit. A relay without the binding (an
 * older self-hosted config) has no limit. Logged without the client's address,
 * so Workers Logs can count how often it happens.
 */
export async function overLimit(
  limiter: RateLimit | undefined,
  request: Request,
  route: string,
): Promise<boolean> {
  if (!limiter) return false
  const { success } = await limiter.limit({ key: clientKey(request) })
  if (!success) console.log(`rate limited ${route}`)
  return !success
}

/**
 * Optional rate limit bindings (see the ratelimits in wrangler.jsonc), and the
 * maintenance level, set in the dashboard when the relay has to stop: no new
 * rooms, or closed altogether.
 */
type Bindings = Omit<Env, 'ROOM_CREATION_LIMIT' | 'CONNECTION_LIMIT'> & {
  ROOM_CREATION_LIMIT?: RateLimit
  CONNECTION_LIMIT?: RateLimit
  MAINTENANCE?: string
  KEEP_PUBLIC_V6?: string
  // Where the Markdown preview may load images and videos from (docs/self-hosting.md).
  MEDIA_SOURCES?: string
}

const UNDER_MAINTENANCE =
  'This relay is not taking new rooms right now, for maintenance. Try again later, or run a relay of your own: https://github.com/piconic-ai/pedit/blob/main/docs/self-hosting.md'
const CLOSED_FOR_MAINTENANCE = 'This relay is closed for maintenance. Try again later.'

// The subprotocol to answer an upgrade in when accepting it only to close it:
// one the client offered, or it never sees the close.
function offeredProtocol(request: Request): string | undefined {
  const version = checkProtocolVersion(request.headers.get('Sec-WebSocket-Protocol'))
  return 'offered' in version ? version.offered : undefined
}

const app = new Hono<{ Bindings: Bindings }>()

// Loopback stays on plain HTTP, for wrangler dev.
function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    // An IPv4 literal in 127.0.0.0/8, not a DNS name that happens to start with 127.
    /^127(\.\d{1,3}){3}$/.test(hostname)
  )
}

// A page served over plain HTTP could be rewritten on the way to read the key in
// its fragment, so plain HTTP only ever gets a redirect. The browser keeps the
// fragment across it. 308 keeps the method of anything but a GET or HEAD.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url)
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  if (path === '/internal/kept' || path.startsWith('/internal/kept/')) {
    if (c.env.KEEP_PUBLIC_V6 !== '1') return new Response(null, { status: 404 })
    if (path !== url.pathname || url.search || url.hash) return new Response(null, { status: 400 })
  }
  if (url.protocol !== 'http:' || isLoopback(url.hostname)) return next()
  url.protocol = 'https:'
  const status = c.req.method === 'GET' || c.req.method === 'HEAD' ? 301 : 308
  return c.redirect(url.href, status)
})

app.post('/api/rooms', async (c) => {
  const level = maintenance(c.env)
  if (level !== 'none') {
    return c.text(level === 'closed' ? CLOSED_FOR_MAINTENANCE : UNDER_MAINTENANCE, 503)
  }
  if (await overLimit(c.env.ROOM_CREATION_LIMIT, c.req.raw, 'POST /api/rooms')) {
    return c.text('Too many rooms were created from your network. Try again in a minute.', 429, {
      'Retry-After': '60',
    })
  }
  const hostToken = base64url(crypto.getRandomValues(new Uint8Array(32)))
  return c.json({ id: await roomIdFor(hostToken), hostToken }, 201)
})

app.get('/api/rooms/:id/ws', async (c) => {
  const id = c.req.param('id')
  if (!ROOM_ID.test(id)) return c.text('invalid room id', 400)
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('expected a WebSocket upgrade', 426)
  }
  if (!allowedOrigin(c.req.raw)) return c.text('cross-origin WebSocket not allowed', 403)
  if (maintenance(c.env) === 'closed') {
    return refuse(RELAY_MAINTENANCE, 'closed for maintenance', offeredProtocol(c.req.raw))
  }
  if (await overLimit(c.env.CONNECTION_LIMIT, c.req.raw, 'GET /api/rooms/:id/ws')) {
    return refuse(RELAY_BUSY, 'too many connections from your network', offeredProtocol(c.req.raw))
  }

  // Never trust a role header coming from outside.
  const headers = new Headers(c.req.raw.headers)
  headers.delete(HOST_HEADER)
  const auth = c.req.header('Authorization')
  if (auth) {
    const token = /^Bearer (\S+)$/.exec(auth)?.[1]
    if (!token || (await roomIdFor(token)) !== id) return c.text('invalid host token', 403)
    headers.set(HOST_HEADER, '1')
  }

  const room = c.env.ROOM.get(c.env.ROOM.idFromName(id))
  return room.fetch(new Request(c.req.raw, { headers }))
})

// The public bridge only exposes the explicitly listed v6 Room operations.
// It forwards streams without buffering; Room retains authentication and its
// own body, lifecycle, and per-role limits.
const KEPT_METHODS: Record<string, readonly string[]> = {
  initialize: ['POST'],
  read: ['POST', 'GET', 'DELETE'],
  append: ['POST'],
  host: ['GET'],
  guest: ['GET'],
  close: ['POST'],
  blobs: ['GET', 'PUT'],
}
const KEPT_HEADERS = [
  'Authorization',
  'Upgrade',
  'Sec-WebSocket-Protocol',
  'Content-Length',
  'Content-Type',
  'X-Pedit-Editor',
  'X-Pedit-Commenter',
  'X-Pedit-Reader',
  'X-Pedit-Epoch',
  'X-Pedit-Keep-Seconds',
  'X-Pedit-Read-Session',
  'X-Pedit-Read-Cursor',
]

function validateKeptRequest(
  request: Request,
  id: string,
  action: string,
  blob?: string,
): Response | undefined {
  const methods = Object.hasOwn(KEPT_METHODS, action) ? KEPT_METHODS[action] : undefined
  if (
    !ROOM_ID.test(id) ||
    !methods ||
    (action === 'blobs' && (!blob || !BLOB_ID.test(blob))) ||
    new URL(request.url).search
  )
    return new Response(null, { status: 400 })
  if (!methods.includes(request.method)) return new Response(null, { status: 405 })
  if (!allowedOrigin(request)) return new Response(null, { status: 403 })
  const socket = action === 'host' || action === 'guest'
  const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
  if (socket && !upgrade) return new Response(null, { status: 426 })
  if (!socket && request.headers.has('Upgrade')) return new Response(null, { status: 400 })
}

async function keptRate(
  request: Request,
  env: Bindings,
  action: string,
): Promise<Response | undefined> {
  if (!env.CONNECTION_LIMIT || !env.ROOM_CREATION_LIMIT) return new Response(null, { status: 503 })
  try {
    if (await overLimit(env.CONNECTION_LIMIT, request, 'v6 request'))
      return new Response(null, { status: 429 })
    if (
      action === 'initialize' &&
      (await overLimit(env.ROOM_CREATION_LIMIT, request, 'v6 initialize'))
    )
      return new Response(null, { status: 429 })
  } catch {
    return new Response(null, { status: 503 })
  }
}

async function forwardKept(
  request: Request,
  env: Bindings,
  id: string,
  action: string,
  blob?: string,
): Promise<Response> {
  if (env.KEEP_PUBLIC_V6 !== '1') return new Response(null, { status: 404 })
  const invalid = validateKeptRequest(request, id, action, blob)
  if (invalid) return invalid
  const level = maintenance(env)
  if (level === 'closed' || (action === 'initialize' && level !== 'none'))
    return new Response(null, { status: 503 })
  const limited = await keptRate(request, env, action)
  if (limited) return limited
  const headers = new Headers()
  for (const name of KEPT_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  const path = `/internal/kept/${id}/${action}${blob ? `/${blob}` : ''}`
  const dest = new URL(path, new URL(request.url).origin)
  try {
    const room = env.ROOM.get(env.ROOM.idFromName(id))
    return await room.fetch(
      new Request(dest, { method: request.method, headers, body: request.body }),
    )
  } catch {
    return new Response(null, { status: 503 })
  }
}

app.all('/internal/kept/:id/:action', (c) =>
  forwardKept(c.req.raw, c.env, c.req.param('id'), c.req.param('action')),
)
app.all('/internal/kept/:id/blobs/:blob', (c) =>
  forwardKept(c.req.raw, c.env, c.req.param('id'), 'blobs', c.req.param('blob')),
)

// Encrypted attachments, stored while the room's host is connected. The Room
// verifies the admission capability before allowing reads or writes.
app.all('/api/rooms/:id/blobs/:blobId', async (c) => {
  if (maintenance(c.env) === 'closed') return c.text(CLOSED_FOR_MAINTENANCE, 503)
  const id = c.req.param('id')
  const blobId = c.req.param('blobId')
  if (!ROOM_ID.test(id) || !BLOB_ID.test(blobId)) {
    return c.text('invalid room or blob id', 400)
  }
  if (c.req.header('Upgrade')) return c.text('attachments are not WebSockets', 400)
  // The Room picks blob or WebSocket handling by path, so it gets the path
  // the ids were checked in: the client's may be percent-encoded. A role
  // header from outside is never passed on.
  const headers = new Headers(c.req.raw.headers)
  headers.delete(HOST_HEADER)
  const url = new URL(`/api/rooms/${id}/blobs/${blobId}`, c.req.url)
  const room = c.env.ROOM.get(c.env.ROOM.idFromName(id))
  return room.fetch(new Request(url, { method: c.req.method, headers, body: c.req.raw.body }))
})

// Everything but /api/* is a page or a static file: Workers Assets serves it, and the
// Worker adds the security headers to HTML (wrangler.jsonc run_worker_first).
app.notFound((c) =>
  c.req.path.startsWith('/api/') ||
  c.req.path === '/internal/kept' ||
  c.req.path.startsWith('/internal/kept/')
    ? c.text('404 Not Found', 404)
    : servePage(c.req.raw, c.env),
)

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(scheduledKeptSweep(env))
  },
}
