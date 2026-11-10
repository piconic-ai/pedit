import { checkProtocolVersion } from '@pedit/protocol/admission'
import { RELAY_BUSY, RELAY_MAINTENANCE } from '@pedit/protocol/close'
import { type Context, Hono } from 'hono'
import { base64url, newHostToken, tokenIssuedAt } from './host-token.ts'
import { FOREIGN_ORIGIN_HEADER, ORIGINS_HEADER } from './origins.ts'
import { embedSourcesFor, mediaSourcesFrom, scriptHashes, servePage } from './page.ts'
import { HOST_HEADER, ISSUED_HEADER, KEEP_HEADER, maintenance, refuse } from './room.ts'

export { maintenance, Room } from './room.ts'
export { embedSourcesFor, mediaSourcesFrom, scriptHashes, servePage }

// Room ids are 128+ bits, base64url without padding.
const ROOM_ID = /^[A-Za-z0-9_-]{22}$/
// Blob ids are 128-bit HMACs, base64url without padding.
const BLOB_ID = /^[A-Za-z0-9_-]{22}$/

/**
 * A room id is derived from its host token, so the Worker can tell the host
 * apart without storing anything: only whoever created the room knows a token
 * that hashes to its id.
 */
export async function roomIdFor(hostToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostToken))
  return base64url(new Uint8Array(digest)).slice(0, 22)
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
 * The Origin of a browser request that is not from the relay's own pages, or
 * null. The Durable Object decides whether its room admits it.
 */
export function foreignOrigin(request: Request): string | null {
  const origin = request.headers.get('Origin')
  return origin === null || origin === new URL(request.url).origin ? null : origin
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
type Bindings = Omit<Env, 'ROOM_CREATION_LIMIT' | 'CONNECTION_LIMIT' | 'KEEP_REQUEST_LIMIT'> & {
  ROOM_CREATION_LIMIT?: RateLimit
  CONNECTION_LIMIT?: RateLimit
  KEEP_REQUEST_LIMIT?: RateLimit
  MAINTENANCE?: string
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
  if (version.result === 'current') return `pedit-v${version.version}`
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
  const hostToken = newHostToken()
  return c.json({ id: await roomIdFor(hostToken), hostToken }, 201)
})

// What the host asks of a room it may not hold a connection to: close a kept
// room, read its status, change its keep. The room answers; the Worker only
// checks the host token and passes the role on.
async function hostRequest(c: Context<{ Bindings: Bindings }>, label: string): Promise<Response> {
  const id = c.req.param('id')
  if (!id || !ROOM_ID.test(id) || !allowedOrigin(c.req.raw))
    return c.text('invalid room request', 400)
  const level = maintenance(c.env)
  if (level === 'closed') return c.text(CLOSED_FOR_MAINTENANCE, 503)
  if (await overLimit(c.env.KEEP_REQUEST_LIMIT, c.req.raw, label))
    return c.text('Too many kept room requests', 429, { 'Retry-After': '60' })

  // The keep is the host's to ask for, so it goes on only with a host token
  // that checked out.
  const headers = new Headers(c.req.raw.headers)
  headers.delete(HOST_HEADER)
  headers.delete(ISSUED_HEADER)
  headers.delete(KEEP_HEADER)
  headers.delete(FOREIGN_ORIGIN_HEADER)
  const auth = c.req.header('Authorization')
  if (auth) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(auth)?.[1]
    if (!token || (await roomIdFor(token)) !== id) return c.text('invalid host token', 403)
    headers.set(HOST_HEADER, '1')
    const keep = c.req.header(KEEP_HEADER)
    if (keep !== undefined) headers.set(KEEP_HEADER, keep)
  }
  return c.env.ROOM.get(c.env.ROOM.idFromName(id)).fetch(new Request(c.req.raw, { headers }))
}

app.post('/api/rooms/:id/keep/close', (c) => hostRequest(c, 'keep close'))
app.get('/api/rooms/:id/keep', (c) => hostRequest(c, 'keep status'))
app.post('/api/rooms/:id/keep', (c) => hostRequest(c, 'keep change'))

app.get('/api/rooms/:id/ws', async (c) => {
  const id = c.req.param('id')
  if (!ROOM_ID.test(id)) return c.text('invalid room id', 400)
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('expected a WebSocket upgrade', 426)
  }
  const foreign = foreignOrigin(c.req.raw)
  // The host is the CLI, never a page.
  if (foreign !== null && c.req.header('Authorization')) {
    return c.text('cross-origin WebSocket not allowed', 403)
  }
  if (maintenance(c.env) === 'closed') {
    return refuse(RELAY_MAINTENANCE, 'closed for maintenance', offeredProtocol(c.req.raw))
  }
  if (await overLimit(c.env.CONNECTION_LIMIT, c.req.raw, 'GET /api/rooms/:id/ws')) {
    return refuse(RELAY_BUSY, 'too many connections from your network', offeredProtocol(c.req.raw))
  }

  // Never trust a role header coming from outside. The keep is the host's to
  // ask for, so it goes on only with a host token that checked out.
  const headers = new Headers(c.req.raw.headers)
  headers.delete(HOST_HEADER)
  headers.delete(ISSUED_HEADER)
  headers.delete(KEEP_HEADER)
  headers.delete(ORIGINS_HEADER)
  headers.delete(FOREIGN_ORIGIN_HEADER)
  if (foreign !== null) headers.set(FOREIGN_ORIGIN_HEADER, foreign)
  const auth = c.req.header('Authorization')
  if (auth) {
    const token = /^Bearer (\S+)$/.exec(auth)?.[1]
    if (!token || (await roomIdFor(token)) !== id) return c.text('invalid host token', 403)
    headers.set(HOST_HEADER, '1')
    // The room checks the issue time when its host first opens it.
    const issued = tokenIssuedAt(token)
    if (issued !== undefined) headers.set(ISSUED_HEADER, String(issued))
    const keep = c.req.header(KEEP_HEADER)
    if (keep !== undefined) headers.set(KEEP_HEADER, keep)
    const origins = c.req.header(ORIGINS_HEADER)
    if (origins !== undefined) headers.set(ORIGINS_HEADER, origins)
  }

  const room = c.env.ROOM.get(c.env.ROOM.idFromName(id))
  return room.fetch(new Request(c.req.raw, { headers }))
})

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
  headers.delete(ISSUED_HEADER)
  headers.delete(ORIGINS_HEADER)
  headers.delete(FOREIGN_ORIGIN_HEADER)
  const foreign = foreignOrigin(c.req.raw)
  if (foreign !== null) headers.set(FOREIGN_ORIGIN_HEADER, foreign)
  const url = new URL(`/api/rooms/${id}/blobs/${blobId}`, c.req.url)
  const room = c.env.ROOM.get(c.env.ROOM.idFromName(id))
  return room.fetch(new Request(url, { method: c.req.method, headers, body: c.req.raw.body }))
})

// Everything but /api/* is a page or a static file: Workers Assets serves it, and the
// Worker adds the security headers to HTML (wrangler.jsonc run_worker_first).
app.notFound((c) =>
  c.req.path.startsWith('/api/') ? c.text('404 Not Found', 404) : servePage(c.req.raw, c.env),
)

export default app
