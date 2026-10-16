import { DurableObject } from 'cloudflare:workers'
import {
  ADMISSION_HEADER,
  ADMISSION_PATTERN,
  checkProtocolVersion,
  readAdmissionProtocol,
  SOCKET_PROTOCOL,
} from '@pedit/protocol/admission'
import {
  CLIENT_OUTDATED,
  expiredReason,
  MESSAGE_TOO_BIG,
  RELAY_MAINTENANCE,
  ROOM_CLOSED,
  ROOM_EXPIRED,
  ROOM_FULL,
  SERVER_OUTDATED,
} from '@pedit/protocol/close'
import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'

// Shared browser code brings DOM's SubtleCrypto into this program. Augment it
// with the documented Workers extension also present in our generated types.
declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean
  }
}

/** Connections one room takes at most, hosts included. */
export const MAX_PEERS = 32
/** Set by the Worker (never by clients) on the host's upgrade request. */
export const HOST_HEADER = 'X-Pedit-Host'

/** AES-GCM's IV and tag around an encrypted attachment. */
export const BLOB_OVERHEAD = 28
/** Uploads one room takes at once; each is held in memory until it is stored. */
export const MAX_UPLOADS = 4

/**
 * What one connection may send: a burst, then a steady rate. Messages are what
 * a room is billed for, so they are counted, but above the busiest editing:
 * dragging on a canvas sends the pointer once per frame, up to 144 times a
 * second on fast displays, besides typing and cursors. Bytes are counted
 * loosely: every
 * peer answers a newcomer with the whole document (one message of at most
 * MAX_FRAME_BYTES), so a full room reconnecting at once must fit.
 *
 * A guest over it is closed, and its client reconnects and resyncs, which
 * loses nothing. A host over it ends the session, as any host leaving does,
 * so the limits stay far above what editing needs.
 */
export const MESSAGE_RATE = { burst: 1000, perSecond: 200 }
export const BYTE_RATE = { burst: MAX_PEERS * MAX_FRAME_BYTES, perSecond: 1024 * 1024 }
/** Close code for a connection over its rate: a policy violation. */
export const RATE_LIMITED = 1008

/**
 * How often a room with a host checks that its host is still there. Each check
 * is one Durable Object request, billed like 20 WebSocket messages; an idle
 * room already sends hundreds of awareness messages an hour. It bounds how long
 * a room whose host vanished without a close (a deploy drops every connection
 * with no hook) keeps its data.
 */
export const ALARM_INTERVAL_MS = 60 * 60 * 1000

/**
 * What a room allows. The defaults suit a self-hosted relay; the public relay
 * sets lower ones as Worker vars (wrangler.jsonc), and the tests set their own
 * (vitest.config.ts).
 */
export interface Limits {
  /** Guests at once, the host not counted. */
  guests: number
  /** One attachment, before encryption. */
  blobBytes: number
  /** All attachments of a session together, encrypted, and their number. */
  quotaBytes: number
  quotaCount: number
  /** How long a room lasts, from its host's first connection. */
  roomSeconds: number
}

export const DEFAULT_LIMITS: Limits = {
  guests: MAX_PEERS - 1,
  blobBytes: 10 * 1024 * 1024,
  quotaBytes: 100 * 1024 * 1024,
  quotaCount: 500,
  // Unlimited: the limit protects a shared demo relay. A self-hosted relay
  // serves its operator's own team, who may keep a session open for days, and
  // the operator can set ROOM_MAX_SECONDS.
  roomSeconds: Number.POSITIVE_INFINITY,
}

/** Worker vars that lower or raise the limits; unset or invalid ones keep the default. */
export interface LimitVars {
  ROOM_GUESTS?: string
  BLOB_MAX_BYTES?: string
  BLOB_QUOTA_BYTES?: string
  BLOB_QUOTA_COUNT?: string
  ROOM_MAX_SECONDS?: string
}

export function limits(env: LimitVars): Limits {
  const positive = (value: string | undefined, fallback: number) => {
    const n = Number(value)
    return Number.isSafeInteger(n) && n > 0 ? n : fallback
  }
  return {
    guests: Math.min(positive(env.ROOM_GUESTS, DEFAULT_LIMITS.guests), MAX_PEERS - 1),
    blobBytes: positive(env.BLOB_MAX_BYTES, DEFAULT_LIMITS.blobBytes),
    quotaBytes: positive(env.BLOB_QUOTA_BYTES, DEFAULT_LIMITS.quotaBytes),
    quotaCount: positive(env.BLOB_QUOTA_COUNT, DEFAULT_LIMITS.quotaCount),
    roomSeconds: positive(env.ROOM_MAX_SECONDS, DEFAULT_LIMITS.roomSeconds),
  }
}

type Maintenance = 'none' | 'no-new-rooms' | 'closed'

/**
 * The maintenance level in force, from the MAINTENANCE Worker var set in the
 * dashboard. Anything but the known values is none.
 */
export function maintenance(env: { MAINTENANCE?: string }): Maintenance {
  const level = env.MAINTENANCE?.trim()
  return level === 'no-new-rooms' || level === 'closed' ? level : 'none'
}

const HOST_TAG = 'host'
const BLOB_PATH = /\/blobs\/([A-Za-z0-9_-]{22})$/
const USAGE_KEY = 'blobUsage'
const ADMISSION_KEY = 'admissionHash'
// When the host first connected, in ms since the epoch. Never deleted: once
// the room is over it is the tombstone that stops its ID being used again.
const OPENED_KEY = 'openedAt'

interface Usage {
  bytes: number
  count: number
}

/**
 * A room relays encrypted frames between its peers. It never parses or stores them;
 * it cannot, since it never sees the key.
 *
 * A room lives only as long as its host is connected: guests are turned away
 * while there is no host, and everyone is disconnected with ROOM_CLOSED as soon
 * as the host leaves, so nothing lingers (and nothing keeps waking the room up)
 * after a session ends.
 *
 * A room also ends at most ROOM_MAX_SECONDS after its host first connected
 * (`openedAt`, kept after the room ends so that its ID cannot be reused), with
 * ROOM_EXPIRED for everyone. An hourly alarm cleans up a room whose host
 * vanished without a close, as on a deploy.
 *
 * Attachments are the one thing a room keeps: encrypted blobs in R2, only while
 * the host is connected, deleted when the host leaves. The room counts their
 * size and number (never their content) to enforce its quota.
 */
export class Room extends DurableObject<Env> {
  // Blob ids being uploaded right now, so two uploads of one id cannot race.
  private readonly uploading = new Set<string>()
  // What each connection may still send. In memory only: a room that wakes
  // from hibernation starts everyone with a full allowance, which is fine.
  private readonly allowances = new WeakMap<WebSocket, Allowance>()
  // What the allowances are refilled by; the tests stop and move it.
  private now = () => Date.now()
  // Deleting the blobs of a session that just ended. A reconnecting host must
  // not start using blobs before it finishes.
  private cleaning: Promise<void> = Promise.resolve()
  // Bumped by every cleanup, so an upload that spans one knows its quota
  // reservation belonged to the session that ended. In memory only: nothing
  // is in flight while the room hibernates.
  private generation = 0
  // Host connections between the start of fetch and the accept or refusal.
  private hostHandshakes = 0

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const blob = BLOB_PATH.exec(path)?.[1]
    if (blob) return this.blob(request, blob)
    // Only a connection goes on: a blob path the pattern missed is not one.
    if (path.includes('/blobs/')) return new Response('invalid blob id', { status: 400 })

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 })
    }
    const protocols = request.headers.get('Sec-WebSocket-Protocol')
    // Checked first, so a client too old or too new is told so instead of
    // retrying an admission it cannot pass.
    const version = checkProtocolVersion(protocols)
    if (version.result === 'client-outdated') {
      return refuse(CLIENT_OUTDATED, 'pedit is outdated; update it', version.offered)
    }
    if (version.result === 'server-outdated') {
      return refuse(SERVER_OUTDATED, 'the server is older than this pedit', version.offered)
    }
    const token = readAdmissionProtocol(protocols)
    if (!token) return new Response('room admission required; update your client', { status: 403 })
    const isHost = request.headers.get(HOST_HEADER) === '1'
    // The hash below is an await during which an alarm may run. Counting the
    // host handshakes in flight keeps that alarm from cleaning up a session
    // whose host is just reconnecting.
    if (isHost) this.hostHandshakes++
    try {
      return await this.admit(token, isHost)
    } finally {
      if (isHost) this.hostHandshakes--
    }
  }

  private async admit(token: string, isHost: boolean): Promise<Response> {
    const digest = await sha256(token)
    // Nothing below awaits before the socket is accepted, so an alarm cannot
    // expire the room between these checks and the accept. An expired room
    // refuses everyone before admission, so it never registers a verifier again.
    // Clients released before ROOM_EXPIRED existed treat 4007 as an ordinary
    // drop and keep reconnecting (with backoff) to an expired room; accepted,
    // since the time limit is final for every current client.
    if (this.expired()) {
      if (this.sessionOpen()) await this.expire()
      return refuse(ROOM_EXPIRED, expiredReason(limits(this.env).roomSeconds))
    }
    if (!isHost && this.hosts().length === 0) return refuse(ROOM_CLOSED, 'room is closed')
    // Authenticate before taking a peer slot. Only the authenticated host may
    // register the verifier; a guest cannot claim an unopened room's token.
    if (!this.authorize(digest, isHost))
      return new Response('invalid room admission', { status: 403 })
    const peers = this.ctx.getWebSockets().length
    const guests = peers - this.hosts().length
    if (peers >= MAX_PEERS || (!isHost && guests >= limits(this.env).guests)) {
      return refuse(ROOM_FULL, 'room is full')
    }
    // The clock starts at the host's first connection and never again.
    if (isHost && this.openedAt() === undefined) this.ctx.storage.kv.put(OPENED_KEY, Date.now())
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, isHost ? [HOST_TAG] : [])
    if (isHost) await this.ctx.storage.setAlarm(this.nextAlarm())
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': SOCKET_PROTOCOL },
    })
  }

  // Takes the digest of the admission token, hashed before this runs.
  private authorize(digest: ArrayBuffer, register = false): boolean {
    // Persist the verifier across hibernation. Read after hashing so concurrent
    // host handshakes cannot each install a different token.
    const expected = this.ctx.storage.kv.get<ArrayBuffer>(ADMISSION_KEY)
    if (expected) return crypto.subtle.timingSafeEqual(expected, digest)
    if (!register) return false
    this.ctx.storage.kv.put(ADMISSION_KEY, digest)
    return true
  }

  private openedAt(): number | undefined {
    return this.ctx.storage.kv.get<number>(OPENED_KEY)
  }

  // The room's deadline, or Infinity without a limit or before its host came.
  private deadline(): number {
    const opened = this.openedAt()
    if (opened === undefined) return Number.POSITIVE_INFINITY
    return opened + limits(this.env).roomSeconds * 1000
  }

  // Date.now() rather than the `now` seam: the tests stop that one at 0.
  private expired(): boolean {
    return Date.now() >= this.deadline()
  }

  // The hourly check, or the deadline if that comes sooner.
  private nextAlarm(): number {
    return Math.min(this.deadline(), Date.now() + ALARM_INTERVAL_MS)
  }

  // Whether there is anything of a session left to clean up.
  private sessionOpen(): boolean {
    return (
      this.ctx.storage.kv.get(ADMISSION_KEY) !== undefined || this.ctx.getWebSockets().length > 0
    )
  }

  /**
   * Alarms are at-least-once and may come late, so this does only what is
   * still needed and can run twice.
   */
  override async alarm(): Promise<void> {
    if (this.expired()) {
      await this.expire()
      return
    }
    if (this.hosts().length === 0) {
      // A host is reconnecting right now (after a deploy): let it finish, and
      // look again at the next interval if it does not get in.
      if (this.hostHandshakes > 0) {
        await this.ctx.storage.setAlarm(this.nextAlarm())
        return
      }
      // The host left without a close we saw (a deploy), or normally, when
      // there is nothing left to do. Not armed again until a host connects.
      if (this.sessionOpen()) await this.endSession(ROOM_CLOSED, 'the host left')
      return
    }
    await this.ctx.storage.setAlarm(this.nextAlarm())
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') {
      ws.close(1003, 'binary frames only')
      return
    }
    if (message.byteLength > MAX_FRAME_BYTES) {
      ws.close(MESSAGE_TOO_BIG, 'message too big')
      return
    }
    // Before maintenance: expiry is permanent, so reporting maintenance would
    // only invite a Resume. This backs up a late or lost alarm.
    if (this.expired()) {
      await this.expire()
      return
    }
    // Setting the var redeploys the Worker, which normally restarts rooms and
    // drops their connections, but Cloudflare may keep a room running on a
    // change of vars only. Then its next message, at the latest a client's
    // awareness renewal every 15 s, closes it.
    if (maintenance(this.env as { MAINTENANCE?: string }) === 'closed') {
      for (const peer of this.ctx.getWebSockets()) {
        safeClose(peer, RELAY_MAINTENANCE, 'closed for maintenance')
      }
      return
    }
    if (!this.allow(ws, message.byteLength)) {
      ws.close(RATE_LIMITED, 'rate limited')
      return
    }
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue
      try {
        peer.send(message)
      } catch {
        // The peer is going away; its close handler cleans up.
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    safeClose(ws, code, reason)
    await this.closeIfHostLeft(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    safeClose(ws, 1011, 'error')
    await this.closeIfHostLeft(ws)
  }

  // Takes one message of `bytes` from the connection's allowance, refilled
  // with the time since its last message.
  private allow(ws: WebSocket, bytes: number): boolean {
    const now = this.now()
    const a = this.allowances.get(ws) ?? {
      messages: MESSAGE_RATE.burst,
      bytes: BYTE_RATE.burst,
      at: now,
    }
    const seconds = Math.max(0, now - a.at) / 1000
    a.messages = Math.min(MESSAGE_RATE.burst, a.messages + seconds * MESSAGE_RATE.perSecond)
    a.bytes = Math.min(BYTE_RATE.burst, a.bytes + seconds * BYTE_RATE.perSecond)
    a.at = now
    this.allowances.set(ws, a)
    if (a.messages < 1 || a.bytes < bytes) return false
    a.messages -= 1
    a.bytes -= bytes
    return true
  }

  private hosts(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets(HOST_TAG).filter((s) => s !== except)
  }

  private async closeIfHostLeft(ws: WebSocket): Promise<void> {
    if (!this.ctx.getTags(ws).includes(HOST_TAG) || this.hosts(ws).length > 0) return
    await this.endSession(ROOM_CLOSED, 'the host left', ws)
  }

  // The room reached its time limit: everyone goes, with the session's data.
  // Its `openedAt` stays, so the room ID is never opened again.
  private async expire(): Promise<void> {
    await this.endSession(ROOM_EXPIRED, expiredReason(limits(this.env).roomSeconds))
  }

  // Everything before the first await runs synchronously, which the
  // generation and cleaning invariants rely on.
  private async endSession(code: number, reason: string, except?: WebSocket): Promise<void> {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== except) safeClose(peer, code, reason)
    }
    // End the session at once: its quota and uploads no longer count.
    this.generation++
    this.ctx.storage.kv.delete(USAGE_KEY)
    this.ctx.storage.kv.delete(ADMISSION_KEY)
    this.cleaning = this.cleaning.then(() => this.deleteBlobs())
    await this.cleaning
  }

  private async blob(request: Request, id: string): Promise<Response> {
    const token = request.headers.get(ADMISSION_HEADER)
    if (!token || !ADMISSION_PATTERN.test(token))
      return new Response('room admission required', { status: 403 })
    // Another session may end while we wait, chaining a newer cleanup.
    let cleaning: Promise<void>
    do {
      cleaning = this.cleaning
      await cleaning
    } while (cleaning !== this.cleaning)
    if (this.expired()) return new Response('room has expired', { status: 410 })
    if (this.hosts().length === 0) return new Response('room is closed', { status: 410 })
    // Hashed first, so the verifier is read after any await.
    if (!this.authorize(await sha256(token)))
      return new Response('invalid room admission', { status: 403 })
    const key = this.blobPrefix() + id
    if (request.method === 'GET') {
      const object = await this.env.BLOBS.get(key)
      if (!object) return new Response('no such blob', { status: 404 })
      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(object.size),
          'Cache-Control': 'private, max-age=3600',
        },
      })
    }
    if (request.method === 'PUT') return this.putBlob(request, key)
    return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, PUT' } })
  }

  private async putBlob(request: Request, key: string): Promise<Response> {
    const header = request.headers.get('Content-Length')
    const length = Number(header)
    if (!header || !Number.isSafeInteger(length) || length < 0) {
      return new Response('Content-Length required', { status: 411 })
    }
    if (length > limits(this.env).blobBytes + BLOB_OVERHEAD) {
      return new Response('blob too large', { status: 413 })
    }
    // Claim the id before awaiting anything.
    if (this.uploading.has(key)) return new Response('upload in progress', { status: 409 })
    // Each upload is held in memory whole, so take only a few at once.
    if (this.uploading.size >= MAX_UPLOADS) {
      return new Response('too many uploads at once', {
        status: 503,
        headers: { 'Retry-After': '1' },
      })
    }
    this.uploading.add(key)
    try {
      return await this.upload(request, key, length)
    } finally {
      this.uploading.delete(key)
    }
  }

  private async upload(request: Request, key: string, length: number): Promise<Response> {
    const generation = this.generation
    const ended = () => this.generation !== generation
    const closed = () => new Response('room is closed', { status: 410 })

    // The first upload under an id wins; receivers check the content anyway.
    if (await this.env.BLOBS.head(key)) return new Response(null, { status: 200 })
    if (ended()) return closed()

    // Reserve the quota before awaiting anything else, so concurrent uploads
    // cannot all squeeze in under it.
    const usage = this.usage()
    const { quotaBytes, quotaCount } = limits(this.env)
    if (usage.bytes + length > quotaBytes || usage.count + 1 > quotaCount) {
      return new Response('room quota exceeded', { status: 429 })
    }
    this.setUsage({ bytes: usage.bytes + length, count: usage.count + 1 })
    try {
      const body = await request.arrayBuffer()
      if (body.byteLength !== length) throw new Error('body does not match Content-Length')
      await this.env.BLOBS.put(key, body)
    } catch {
      // A reservation of a session that ended was dropped with it.
      if (!ended()) {
        const now = this.usage()
        this.setUsage({ bytes: now.bytes - length, count: now.count - 1 })
      }
      return new Response('upload failed', { status: 400 })
    }
    // The session may have ended while we were uploading, and its cleanup may
    // have missed this blob.
    if (ended()) {
      await this.env.BLOBS.delete(key)
      return closed()
    }
    return new Response(null, { status: 201 })
  }

  // Deletion failures are left to the bucket's lifecycle rule.
  private async deleteBlobs(): Promise<void> {
    const prefix = this.blobPrefix()
    try {
      let cursor: string | undefined
      do {
        const page = await this.env.BLOBS.list({ prefix, cursor })
        if (page.objects.length > 0) await this.env.BLOBS.delete(page.objects.map((o) => o.key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
    } catch (error) {
      console.error('failed to delete blobs', error)
    }
  }

  // The Durable Object id is derived from the room id, and only this room knows it.
  private blobPrefix(): string {
    return `rooms/${this.ctx.id.toString()}/`
  }

  private usage(): Usage {
    return this.ctx.storage.kv.get<Usage>(USAGE_KEY) ?? { bytes: 0, count: 0 }
  }

  private setUsage(usage: Usage): void {
    this.ctx.storage.kv.put(USAGE_KEY, usage)
  }
}

function sha256(token: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
}

interface Allowance {
  messages: number
  bytes: number
  at: number
}

function safeClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason)
  } catch {
    // Already closed.
  }
}

/**
 * Accepts an upgrade only to close it with a reason: browsers cannot read
 * HTTP errors of a failed upgrade, but they do see close codes. `protocol` is
 * one the client offered, or the handshake would fail before the close.
 */
export function refuse(code: number, reason: string, protocol = SOCKET_PROTOCOL): Response {
  const { 0: client, 1: server } = new WebSocketPair()
  server.accept()
  server.close(code, reason)
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { 'Sec-WebSocket-Protocol': protocol },
  })
}
