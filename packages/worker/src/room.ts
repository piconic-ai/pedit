import { DurableObject } from 'cloudflare:workers'
import {
  ADMISSION_HEADER,
  ADMISSION_PATTERN,
  checkProtocolVersion,
  READ_ADMISSION_HEADER,
  readAdmissionProtocol,
  SOCKET_PROTOCOL,
} from '@pedit/protocol/admission'
import {
  CLIENT_OUTDATED,
  expiredReason,
  HOST_AWAY,
  HOST_BACK,
  HOST_LEFT,
  MESSAGE_TOO_BIG,
  RELAY_MAINTENANCE,
  RELAY_PING,
  RELAY_PONG,
  ROOM_CLOSED,
  ROOM_EXPIRED,
  ROOM_FULL,
  SERVER_OUTDATED,
} from '@pedit/protocol/close'
import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { RELAY_BYTE_RATE, RELAY_MESSAGE_RATE } from '@pedit/protocol/pace'
import { DurableLog } from './durable-log.ts'
import { KEPT_ADMISSION_KEY, KeptAdmission } from './kept-admission.ts'
import { KeptAppendRate, keptAppend } from './kept-append.ts'
import type { KeepPolicy } from './kept-lifecycle.ts'
import { KeptLifecycle } from './kept-lifecycle.ts'
import { initializeKeptRoom } from './kept-room-initialize.ts'
import { keptRoomRead } from './kept-room-read.ts'
import { KEPT_POLICY_KEY } from './kept-transport.ts'
import { ADMISSION_KEY } from './room-storage.ts'

// Shared browser code brings DOM's SubtleCrypto into this program. Augment it
// with the documented Workers extension also present in our generated types.
declare global {
  interface SubtleCrypto {
    timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean
  }
}

/**
 * Connections with an edit link one room takes at most, hosts included.
 * Comment-only and read-only links take at most as many again, apart.
 */
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
 * MAX_FRAME_BYTES), so a full room reconnecting at once must fit. Clients
 * pace what they send to stay within both (packages/protocol/src/pace.ts),
 * which a room that shares several files needs on connecting.
 *
 * A guest over it is closed, and its client reconnects and resyncs, which
 * loses nothing. A host over it is closed too, and the room waits for it to
 * come back as for any host that drops, so the limits stay far above what
 * editing needs.
 */
export const MESSAGE_RATE = RELAY_MESSAGE_RATE
export const BYTE_RATE = RELAY_BYTE_RATE
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
  /** Guests with an edit link at once, the host not counted. */
  guests: number
  /**
   * Guests with a comment-only or read-only link at once, apart from the
   * others, so they cannot take editors' places.
   */
  readers: number
  /** One attachment, before encryption. */
  blobBytes: number
  /** All attachments of a session together, encrypted, and their number. */
  quotaBytes: number
  quotaCount: number
  /** How long a room lasts, from its host's first connection. */
  roomSeconds: number
  /** How long a room waits for a host that dropped before it closes. */
  hostGraceSeconds: number
}

export const DEFAULT_LIMITS: Limits = {
  guests: MAX_PEERS - 1,
  readers: MAX_PEERS - 1,
  blobBytes: 10 * 1024 * 1024,
  quotaBytes: 100 * 1024 * 1024,
  quotaCount: 500,
  // Unlimited: the limit protects a shared demo relay. A self-hosted relay
  // serves its operator's own team, who may keep a session open for days, and
  // the operator can set ROOM_MAX_SECONDS.
  roomSeconds: Number.POSITIVE_INFINITY,
  // Long enough for the CLI's backoff (30 s at most) and a network switch.
  hostGraceSeconds: 120,
}

/** Worker vars that lower or raise the limits; unset or invalid ones keep the default. */
export interface LimitVars {
  ROOM_GUESTS?: string
  ROOM_READERS?: string
  BLOB_MAX_BYTES?: string
  BLOB_QUOTA_BYTES?: string
  BLOB_QUOTA_COUNT?: string
  ROOM_MAX_SECONDS?: string
  HOST_GRACE_SECONDS?: string
}

export function limits(env: LimitVars): Limits {
  const positive = (value: string | undefined, fallback: number) => {
    const n = Number(value)
    return Number.isSafeInteger(n) && n > 0 ? n : fallback
  }
  const guests = Math.min(positive(env.ROOM_GUESTS, DEFAULT_LIMITS.guests), MAX_PEERS - 1)
  return {
    guests,
    // As many as the editors' places unless set: a relay that limits guests
    // limits readers alike.
    readers: Math.min(positive(env.ROOM_READERS, guests), MAX_PEERS - 1),
    blobBytes: positive(env.BLOB_MAX_BYTES, DEFAULT_LIMITS.blobBytes),
    quotaBytes: positive(env.BLOB_QUOTA_BYTES, DEFAULT_LIMITS.quotaBytes),
    quotaCount: positive(env.BLOB_QUOTA_COUNT, DEFAULT_LIMITS.quotaCount),
    roomSeconds: positive(env.ROOM_MAX_SECONDS, DEFAULT_LIMITS.roomSeconds),
    hostGraceSeconds: positive(env.HOST_GRACE_SECONDS, DEFAULT_LIMITS.hostGraceSeconds),
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

const BLOB_SESSION_KEY = 'blobSession'

const HOST_TAG = 'host'
const KEPT_HOST_TAG = 'kept-host'
// A guest admitted with the reader token: a comment-only or read-only link.
const READER_TAG = 'reader'
const BLOB_PATH = /\/blobs\/([A-Za-z0-9_-]{22})$/
const USAGE_KEY = 'blobUsage'
// The digests of the editor and reader admission tokens (access.ts).
const READ_ADMISSION_KEY = 'readAdmissionHash'
// When the host first connected, in ms since the epoch. Never deleted: once
// the room is over it is the tombstone that stops its ID being used again.
const OPENED_KEY = 'openedAt'
// Until when, in ms since the epoch, the room waits for a host that dropped.
const AWAY_KEY = 'hostAwayUntil'

type Role = 'editor' | 'reader'

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
 * after a session ends. A host that drops instead of leaving (its connection
 * ends without HOST_LEFT: a network switch, Cloudflare resetting a connection)
 * gets hostGraceSeconds to come back. Meanwhile the room is told HOST_AWAY,
 * keeps its guests and lets new ones in, and nobody edits; it closes if the
 * host does not come back in time.
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
  // Detects a session ending while an upload runs in this instance. A shutdown
  // can leave an R2 request in flight after memory is discarded; the persisted
  // blob session prefix keeps that old request away from a new session's blobs.
  private generation = 0
  // Host connections between the start of fetch and the accept or refusal.
  private hostHandshakes = 0
  private keptHostHandshakes = 0
  private keptInitializations = { active: 0 }
  private readonly keptAppendRate = new KeptAppendRate()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Answered without waking the room, so a client can check that the room
    // still has its connection at no cost.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG))
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    const keptWrite = /^\/internal\/kept\/([A-Za-z0-9_-]{22})\/append$/.exec(path)
    if (keptWrite?.[1])
      return keptAppend(
        request,
        this.ctx,
        this.env,
        keptWrite[1],
        this.keptAppendRate,
        () => maintenance(this.env as { MAINTENANCE?: string }) === 'closed',
      )
    const keptSocket = /^\/internal\/kept\/([A-Za-z0-9_-]{22})\/host$/.exec(path)
    if (keptSocket?.[1]) return this.keptHostSocket(request, keptSocket[1])
    const keptInit = /^\/internal\/kept\/([A-Za-z0-9_-]{22})\/initialize$/.exec(path)
    if (keptInit?.[1]) {
      const roomSeconds = limits(this.env).roomSeconds
      return initializeKeptRoom(
        request,
        this.ctx,
        this.env,
        keptInit[1],
        Number.isFinite(roomSeconds) ? roomSeconds : null,
        () => maintenance(this.env as { MAINTENANCE?: string }) !== 'none',
        this.keptInitializations,
      )
    }
    const keptRead = /^\/internal\/kept\/([A-Za-z0-9_-]{22})\/read$/.exec(path)
    if (keptRead?.[1])
      return keptRoomRead(
        request,
        this.ctx,
        this.env,
        keptRead[1],
        () => maintenance(this.env as { MAINTENANCE?: string }) === 'closed',
      )
    if (this.ctx.storage.kv.get(KEPT_ADMISSION_KEY) !== undefined)
      return new Response('room protocol unavailable', { status: 403 })
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
    const read = (isHost && request.headers.get(READ_ADMISSION_HEADER)) || null
    if (read !== null && !ADMISSION_PATTERN.test(read)) {
      return new Response('invalid reader admission', { status: 403 })
    }
    // The hash below is an await during which an alarm may run. Counting the
    // host handshakes in flight keeps that alarm from cleaning up a session
    // whose host is just reconnecting.
    if (isHost) this.hostHandshakes++
    try {
      return await this.admit(token, isHost, read)
    } finally {
      if (isHost) this.hostHandshakes--
    }
  }

  private async admit(token: string, isHost: boolean, read: string | null): Promise<Response> {
    const digest = await sha256(token)
    const readDigest = read === null ? null : await sha256(read)
    if (this.ctx.storage.kv.get(KEPT_ADMISSION_KEY) !== undefined)
      return new Response('room protocol unavailable', { status: 403 })
    // Deploys can drop every socket without a close callback. Only a guest
    // with this session's editor admission may start its missing host grace
    // period: the reader token goes to anyone a link was passed on to.
    if (
      !isHost &&
      !this.expired() &&
      this.hosts().length === 0 &&
      this.awayUntil() === undefined &&
      this.role(digest) === 'editor'
    ) {
      await this.waitForHost()
    }
    if (this.ctx.storage.kv.get(KEPT_ADMISSION_KEY) !== undefined)
      return new Response('room protocol unavailable', { status: 403 })
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
    if (!isHost && this.hosts().length === 0 && !this.hostAway()) {
      // A grace period that ran out with its alarm late.
      if (this.awayUntil() !== undefined) await this.closeAfterGrace()
      this.log('turned a guest away', { code: ROOM_CLOSED })
      return refuse(ROOM_CLOSED, 'room is closed')
    }
    // Authenticate before taking a peer slot. Only the authenticated host may
    // register the verifiers; a guest cannot claim an unopened room's tokens.
    const role = isHost ? this.registerHost(digest, readDigest) : this.role(digest)
    if (!role) return new Response('invalid room admission', { status: 403 })
    if (this.full(isHost, role)) return refuse(ROOM_FULL, 'room is full')
    return this.accept(isHost, role)
  }

  // Takes a peer admitted to a place. Nothing awaits before the accept.
  private async accept(isHost: boolean, role: Role): Promise<Response> {
    // The clock starts at the host's first connection and never again.
    if (isHost && this.openedAt() === undefined) this.ctx.storage.kv.put(OPENED_KEY, Date.now())
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, isHost ? [HOST_TAG] : role === 'reader' ? [READER_TAG] : [])
    if (isHost) {
      this.log('host connected')
      if (this.awayUntil() !== undefined) this.hostReturned()
      await this.ctx.storage.setAlarm(this.nextAlarm())
    } else if (this.hostAway()) {
      safeSend(server, HOST_AWAY)
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': SOCKET_PROTOCOL },
    })
  }

  /**
   * Which admission token a digest is, hashed before this runs: the editors'
   * or the readers' (a comment-only or read-only link). The relay uses it
   * only to keep places and uploads for editors; what anyone may change in
   * the room, every peer checks by signatures it cannot see.
   */
  private role(digest: ArrayBuffer): Role | null {
    const kv = this.ctx.storage.kv
    const editor = kv.get<ArrayBuffer>(ADMISSION_KEY)
    if (editor && crypto.subtle.timingSafeEqual(editor, digest)) return 'editor'
    const reader = kv.get<ArrayBuffer>(READ_ADMISSION_KEY)
    if (reader && crypto.subtle.timingSafeEqual(reader, digest)) return 'reader'
    return null
  }

  /**
   * Checks the host's editor token against the session's, or registers both
   * tokens when it has none. Persisted across hibernation, and read after
   * hashing so concurrent host handshakes cannot each install other tokens.
   */
  private registerHost(digest: ArrayBuffer, readDigest: ArrayBuffer | null): Role | null {
    const kv = this.ctx.storage.kv
    const expected = kv.get<ArrayBuffer>(ADMISSION_KEY)
    if (expected) return crypto.subtle.timingSafeEqual(expected, digest) ? 'editor' : null
    kv.put(ADMISSION_KEY, digest)
    kv.put(BLOB_SESSION_KEY, crypto.randomUUID())
    if (readDigest) kv.put(READ_ADMISSION_KEY, readDigest)
    return 'editor'
  }

  /**
   * Whether the room has no place for a newcomer. Readers count apart from
   * everyone else, even against MAX_PEERS, so they cannot take editors'
   * places.
   */
  private full(isHost: boolean, role: Role): boolean {
    const { guests, readers } = limits(this.env)
    const reading = this.ctx.getWebSockets(READER_TAG).length
    if (role === 'reader') return reading >= readers
    const editing = this.ctx.getWebSockets().length - reading
    if (editing >= MAX_PEERS) return true
    if (isHost) return false
    return editing - this.hosts().length >= guests
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

  // The hourly check, or the deadline or the end of a grace period if one
  // comes sooner.
  private nextAlarm(): number {
    return Math.min(
      this.deadline(),
      this.awayUntil() ?? Number.POSITIVE_INFINITY,
      Date.now() + ALARM_INTERVAL_MS,
    )
  }

  private awayUntil(): number | undefined {
    return this.ctx.storage.kv.get<number>(AWAY_KEY)
  }

  // Whether the room is waiting for a host that dropped.
  private hostAway(): boolean {
    const until = this.awayUntil()
    return until !== undefined && Date.now() < until
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
    if (this.ctx.storage.kv.get(KEPT_ADMISSION_KEY) !== undefined) {
      await this.keptAlarm()
      return
    }
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
      if (this.hostAway()) {
        await this.ctx.storage.setAlarm(this.nextAlarm())
        return
      }
      if (this.awayUntil() !== undefined) {
        await this.closeAfterGrace()
        return
      }
      // The host left without a close we saw (a deploy), or normally, when
      // there is nothing left to do. Not armed again until a host connects.
      if (this.sessionOpen()) {
        this.log('alarm found no host')
        await this.endSession(ROOM_CLOSED, 'the host left')
      }
      return
    }
    await this.ctx.storage.setAlarm(this.nextAlarm())
  }

  private async keptAlarm(): Promise<void> {
    const policy = this.ctx.storage.kv.get<KeepPolicy>(KEPT_POLICY_KEY)
    if (policy) {
      const lifecycle = this.keptLifecycle(policy)
      const current = this.keptHostHandshakes
        ? await lifecycle.observe()
        : await lifecycle.reconcileHost(() => this.ctx.getWebSockets(KEPT_HOST_TAG).length > 0)
      if (current.host === 'closed')
        for (const socket of this.ctx.getWebSockets(KEPT_HOST_TAG))
          safeClose(socket, ROOM_CLOSED, 'room closed')
      return
    }
    await KeptLifecycle.observeAlarm(
      this.ctx,
      this.env.ROOM,
      ALARM_INTERVAL_MS / 1000,
      () => maintenance(this.env as { MAINTENANCE?: string }) === 'closed',
    )
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.ctx.getTags(ws).includes(KEPT_HOST_TAG)) {
      safeClose(ws, 1003, 'unsupported')
      return
    }
    if (typeof message === 'string') {
      this.closePeer(ws, 1003, 'binary frames only')
      return
    }
    if (message.byteLength > MAX_FRAME_BYTES) {
      this.closePeer(ws, MESSAGE_TOO_BIG, 'message too big')
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
      this.log('closed for maintenance')
      await this.endSession(RELAY_MAINTENANCE, 'closed for maintenance')
      return
    }
    if (!this.allow(ws, message.byteLength)) {
      this.closePeer(ws, RATE_LIMITED, 'rate limited')
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

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    safeClose(ws, code, reason)
    if (this.ctx.getTags(ws).includes(KEPT_HOST_TAG)) {
      const policy = this.ctx.storage.kv.get<KeepPolicy>(KEPT_POLICY_KEY)
      if (policy)
        await this.keptLifecycle(policy).reconcileHost(() =>
          this.ctx.getWebSockets(KEPT_HOST_TAG).some((other) => other !== ws),
        )
      return
    }
    if (this.isHost(ws))
      this.log('host closed', { code, wasClean, otherHosts: this.hosts(ws).length })
    await this.closeIfHostLeft(ws, code)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    safeClose(ws, 1011, 'error')
    if (this.ctx.getTags(ws).includes(KEPT_HOST_TAG)) {
      const policy = this.ctx.storage.kv.get<KeepPolicy>(KEPT_POLICY_KEY)
      if (policy)
        await this.keptLifecycle(policy).reconcileHost(() =>
          this.ctx.getWebSockets(KEPT_HOST_TAG).some((other) => other !== ws),
        )
      return
    }
    if (this.isHost(ws)) this.log('host errored', { otherHosts: this.hosts(ws).length })
    await this.closeIfHostLeft(ws, 1011)
  }

  private keptLifecycle(policy: KeepPolicy): KeptLifecycle {
    return new KeptLifecycle(
      this.ctx,
      this.env.ROOM,
      policy,
      Date.now,
      () => maintenance(this.env as { MAINTENANCE?: string }) === 'closed',
    )
  }

  private async keptHostSocket(request: Request, roomId: string): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response(null, { status: 426 })
    const host = /^Host ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '')?.[1]
    if (!host) return new Response(null, { status: 403 })
    this.keptHostHandshakes++
    try {
      await new KeptAdmission(this.ctx, this.env.ROOM).authorizeHost(roomId, host)
      const policy = this.ctx.storage.kv.get<KeepPolicy>(KEPT_POLICY_KEY)
      if (!policy) return new Response(null, { status: 403 })
      if (this.full(true, 'editor')) return new Response('room is full', { status: 429 })
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1], [KEPT_HOST_TAG])
      try {
        const state = await this.keptLifecycle(policy).reconcileHost(
          () => this.ctx.getWebSockets(KEPT_HOST_TAG).length > 0,
        )
        if (state.host === 'closed') throw new Error('room closed')
      } catch {
        safeClose(pair[1], ROOM_CLOSED, 'room closed')
        return new Response(null, { status: 403 })
      }
      return new Response(null, { status: 101, webSocket: pair[0] })
    } catch {
      return new Response(null, { status: 403 })
    } finally {
      this.keptHostHandshakes--
    }
  }

  // Closes one connection on the relay's own account.
  private closePeer(ws: WebSocket, code: number, reason: string): void {
    this.log('closed a peer', { code, host: this.isHost(ws) })
    ws.close(code, reason)
  }

  /**
   * Writes one line to Workers Logs, so a session that ended when nobody
   * expected it can be explained afterwards: who left, how, and what the room
   * had then. It names the Durable Object, never the room ID of a link, and
   * nothing a client sent.
   */
  private log(event: string, fields: Record<string, string | number | boolean> = {}): void {
    const opened = this.openedAt()
    const hosts = this.hosts().length
    console.log(
      JSON.stringify({
        message: `room: ${event}`,
        room: this.ctx.id.toString(),
        hosts,
        guests: this.ctx.getWebSockets().length - hosts,
        openSeconds: opened === undefined ? null : Math.round((Date.now() - opened) / 1000),
        ...fields,
      }),
    )
  }

  private isHost(ws: WebSocket): boolean {
    return this.ctx.getTags(ws).includes(HOST_TAG)
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

  private async closeIfHostLeft(ws: WebSocket, code: number): Promise<void> {
    if (!this.isHost(ws)) return
    // Leaving on purpose ends the session, even while the relay still counts
    // older connections of the host it has not seen close yet.
    // Under maintenance no host can come back.
    if (code === HOST_LEFT || maintenance(this.env as { MAINTENANCE?: string }) === 'closed') {
      await this.endSession(ROOM_CLOSED, 'the host left', ws)
      return
    }
    if (this.hosts(ws).length > 0 || this.awayUntil() !== undefined) return
    await this.waitForHost()
  }

  // The last host dropped: wait for it to come back, without editing.
  private async waitForHost(): Promise<void> {
    // The session ended already (it expired, or the host left on purpose):
    // this is its last host closing.
    if (this.ctx.storage.kv.get(ADMISSION_KEY) === undefined) return
    const seconds = limits(this.env).hostGraceSeconds
    this.ctx.storage.kv.put(AWAY_KEY, Date.now() + seconds * 1000)
    this.log('host away', { graceSeconds: seconds })
    for (const peer of this.ctx.getWebSockets()) {
      if (!this.isHost(peer)) safeSend(peer, HOST_AWAY)
    }
    await this.ctx.storage.setAlarm(this.nextAlarm())
  }

  private hostReturned(): void {
    this.ctx.storage.kv.delete(AWAY_KEY)
    this.log('host returned')
    for (const peer of this.ctx.getWebSockets()) {
      if (!this.isHost(peer)) safeSend(peer, HOST_BACK)
    }
  }

  private async closeAfterGrace(): Promise<void> {
    this.log('host did not come back')
    await this.endSession(ROOM_CLOSED, 'the host left')
  }

  // The room reached its time limit: everyone goes, with the session's data.
  // Its `openedAt` stays, so the room ID is never opened again.
  private async expire(): Promise<void> {
    await this.endSession(ROOM_EXPIRED, expiredReason(limits(this.env).roomSeconds))
  }

  // Everything before the first await runs synchronously, which the
  // generation and cleaning invariants rely on.
  private async endSession(code: number, reason: string, except?: WebSocket): Promise<void> {
    // Logged once per session: the close callbacks and alarms that follow
    // clean up again, but the session already ended, for this reason.
    if (this.ctx.storage.kv.get(ADMISSION_KEY) !== undefined) {
      this.log('session ended', { code, reason })
    }
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== except) safeClose(peer, code, reason)
    }
    // End the session at once: its quota and uploads no longer count.
    const prefix = this.blobPrefix()
    const legacy = this.ctx.storage.kv.get(BLOB_SESSION_KEY) === undefined
    this.generation++
    this.ctx.storage.kv.delete(BLOB_SESSION_KEY)
    this.ctx.storage.kv.delete(USAGE_KEY)
    this.ctx.storage.kv.delete(ADMISSION_KEY)
    this.ctx.storage.kv.delete(READ_ADMISSION_KEY)
    this.ctx.storage.kv.delete(AWAY_KEY)
    DurableLog.clear(this.ctx.storage)
    this.cleaning = this.cleaning.then(() => this.deleteBlobs(prefix, legacy))
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
    if (this.hosts().length === 0) {
      if (!this.hostAway()) return new Response('room is closed', { status: 410 })
      // What was attached can still be seen; nothing new goes in.
      if (request.method !== 'GET') return new Response('the host is away', { status: 503 })
    }
    // Hashed first, so the verifier is read after any await.
    const role = this.role(await sha256(token))
    if (!role) return new Response('invalid room admission', { status: 403 })
    // Readers see the images; only editors add them, so nobody else can
    // take an image's place or the room's quota.
    if (request.method === 'PUT' && role !== 'editor') {
      return new Response('adding images needs an edit link', { status: 403 })
    }
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
  private async deleteBlobs(prefix: string, legacy: boolean): Promise<void> {
    try {
      let cursor: string | undefined
      do {
        const page = await this.env.BLOBS.list({ prefix, cursor })
        const keys = page.objects
          .map((object) => object.key)
          .filter((key) => !legacy || /^[A-Za-z0-9_-]{22}$/.test(key.slice(prefix.length)))
        if (keys.length > 0) await this.env.BLOBS.delete(keys)
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
    } catch (error) {
      console.error('failed to delete blobs', error)
    }
  }

  // The Durable Object id is derived from the room id, and only this room knows it.
  private blobPrefix(): string {
    const base = `rooms/${this.ctx.id.toString()}/`
    const session = this.ctx.storage.kv.get<string>(BLOB_SESSION_KEY)
    return session === undefined ? base : `${base}sessions/${session}/`
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

function safeSend(ws: WebSocket, message: string): void {
  try {
    ws.send(message)
  } catch {
    // Going away; its close handler cleans up.
  }
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
