import { checkProtocolVersion } from '@pedit/protocol/admission'
import { RELAY_BUSY, RELAY_MAINTENANCE } from '@pedit/protocol/close'
import { Hono } from 'hono'
import { mediaSourcesFrom, scriptHashes, servePage } from './page.ts'
import { HOST_HEADER, maintenance, refuse } from './room.ts'

export { maintenance, Room } from './room.ts'
export { mediaSourcesFrom, scriptHashes, servePage }

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
  c.req.path.startsWith('/api/') ? c.text('404 Not Found', 404) : servePage(c.req.raw, c.env),
)

export default app
