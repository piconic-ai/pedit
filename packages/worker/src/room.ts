import { DurableObject } from 'cloudflare:workers'
import {
  ADMISSION_HEADER,
  ADMISSION_PATTERN,
  COMMENT_ADMISSION_HEADER,
  checkProtocolVersion,
  commentAdmissionProtocol,
  READ_ADMISSION_HEADER,
  readAdmissionProtocol,
  SOCKET_PROTOCOL,
  socketProtocol,
} from '@pedit/protocol/admission'
import {
  CHECKPOINT,
  CHECKPOINT_REFUSED,
  CLIENT_OUTDATED,
  expiredReason,
  HOST_AWAY,
  HOST_BACK,
  HOST_LEFT,
  KEEP,
  KEPT,
  KEPT_COMMENTS,
  LOG_FULL,
  MESSAGE_TOO_BIG,
  ORIGIN_NOT_ALLOWED,
  RELAY_MAINTENANCE,
  RELAY_PING,
  RELAY_PONG,
  ROOM_CLOSED,
  ROOM_EXPIRED,
  ROOM_FULL,
  SERVER_OUTDATED,
} from '@pedit/protocol/close'
import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import {
  decodeCheckpoint,
  encodeLogged,
  HOST_CLOSED_REASON,
  Kind,
  splitKind,
  withKind,
} from '@pedit/protocol/kinds'
import { RELAY_BYTE_RATE, RELAY_MESSAGE_RATE } from '@pedit/protocol/pace'
import { ISSUE_SKEW_MS, OPEN_WINDOW_MS, tokenEnd } from './host-token.ts'
import {
  appendEntry,
  awayLog,
  checkpoint,
  clearAway,
  hasSnapshot,
  replay,
  storeSnapshot,
} from './kept-away.ts'
import {
  corsHeaders,
  FOREIGN_ORIGIN_HEADER,
  ORIGINS_HEADER,
  parseOrigins,
  preflight,
} from './origins.ts'

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
/** Set by the Worker on the host's upgrade request: when its host token was issued, in ms. */
export const ISSUED_HEADER = 'X-Pedit-Issued'
/**
 * How long the host asks the relay to keep the room after it leaves, in
 * seconds. The Worker passes it on only with a host token that checked out.
 */
export const KEEP_HEADER = 'X-Pedit-Keep'
export { FOREIGN_ORIGIN_HEADER, ORIGINS_HEADER }
/** The last log entry a peer already holds, when it joins a room whose host is away. */
export const AFTER_HEADER = 'X-Pedit-After'

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
  /** How long a host's session lasts, from its first connection or its return to a kept room. */
  roomSeconds: number
  /** How long a room lives in all, from its host's first connection, whatever the host does. */
  lifeSeconds: number
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
  lifeSeconds: 7 * 86400,
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
  /** A host's session: from its first connection or its return to a kept room. */
  ROOM_MAX_SECONDS?: string
  /** The keep after the host leaves is KEEP_MAX_SECONDS (read apart); the whole room, from its opening, is ROOM_LIFE_SECONDS. */
  ROOM_LIFE_SECONDS?: string
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
    lifeSeconds: positive(env.ROOM_LIFE_SECONDS, DEFAULT_LIMITS.lifeSeconds),
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

const HOST_TAG = 'host'
// A guest admitted with the reader token: a comment-only or read-only link.
const READER_TAG = 'reader'
// A reader that also offered the comment token, in version 8: it counts as a
// reader and may also write kind 1 entries.
const COMMENTER_TAG = 'commenter'
// A socket accepted in version 8. SOCKET_PROTOCOL tags every socket this
// deployment accepted, whatever version it negotiated; this one tells version 8.
const V8_TAG = 'v8'
const BLOB_PATH = /\/blobs\/([A-Za-z0-9_-]{22})$/
const USAGE_KEY = 'blobUsage'
// The digests of the editor and reader admission tokens (access.ts).
const ADMISSION_KEY = 'admissionHash'
const READ_ADMISSION_KEY = 'readAdmissionHash'
// The page origins the host admitted (a JSON array), with the admission hashes.
const ORIGINS_KEY = 'origins'
const ORIGIN_REFUSED_REASON = 'this page is not allowed for this room'
// The digest of the comment admission token (version 8), if the host sent one.
const COMMENT_ADMISSION_KEY = 'commentAdmissionHash'
// When the host first connected, in ms since the epoch. Kept after the room
// ends: it is the tombstone that stops the ID being used again, until the
// host token is too old to open it anyway (ISSUED_KEY).
const OPENED_KEY = 'openedAt'
// When the host token the room was opened with was issued, in ms since the
// epoch. At its tokenEnd the room deletes everything it holds. A room opened
// before tokens had a time has none, and keeps its tombstone.
const ISSUED_KEY = 'tokenIssuedAt'
// When the host's current presence began, in ms since the epoch: set when it
// returns to a kept room; absent, it is `openedAt`. The session limit counts
// from it. A reconnect within the grace period does not change it.
const HOST_SINCE_KEY = 'hostSince'
// Until when, in ms since the epoch, the room waits for a host that dropped.
const AWAY_KEY = 'hostAwayUntil'
// How long the host asked to have the room kept, clamped (0: not kept).
const KEEP_KEY = 'keepSeconds'
// Until when, in ms since the epoch, the room is kept without its host.
// Distinct from AWAY_KEY, the grace period: the room may be in either.
const KEPT_AWAY_KEY = 'keptAwayUntil'
// Set when the room ended at the end of its keep, or the host closed it:
// the ID is not opened again.
const EXPIRED_KEY = 'expired'
const CLOSED_KEY = 'closedByHost'
// The tag of a socket that speaks protocol version 6 (a kind byte before each
// message); one without it speaks version 5. Retained across protocol upgrades.
const V6_TAG = 'v6'
// A socket accepted only to be closed with a reason (`refuse`).
const REFUSED_TAG = 'refused'
const KEEP_DEFAULT_MAX_SECONDS = 7 * 24 * 60 * 60

/** What a connection says about itself when it joins. */
interface Join {
  version: number
  /** The subprotocol to answer in. */
  protocol: string
  /** The host's declared keep, clamped; undefined if it declared none. */
  keep?: number
  /** The last log entry the peer holds. */
  after?: number
  /** The page origins a host declares; used on its first connection only. */
  origins: string[]
  /** When the host's token was issued; undefined for a guest or a token without a time. */
  issued?: number
}

type Role = 'editor' | 'commenter' | 'reader'

/** What a connection presents: its subprotocol token, and the host's registrations. */
interface Credentials {
  token: string
  /** The host's reader and comment tokens, from its headers. */
  read: string | null
  comment: string | null
  /** The comment token a guest offered beside its reader token (version 8). */
  offered: string | null
}

/** The credentials after hashing; the tokens themselves are not kept. */
interface Digests {
  token: ArrayBuffer
  read: ArrayBuffer | null
  comment: ArrayBuffer | null
  offered: ArrayBuffer | null
}

const digestOf = (value: string | null) => (value === null ? null : sha256(value))

async function hashed(c: Credentials): Promise<Digests> {
  const [token, read, comment, offered] = await Promise.all([
    sha256(c.token),
    digestOf(c.read),
    digestOf(c.comment),
    digestOf(c.offered),
  ])
  return { token, read, comment, offered }
}

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
 * ROOM_EXPIRED for everyone. Whatever the state, it ends ROOM_LIFE_SECONDS
 * after `openedAt` at the latest, however often its host comes back. An hourly alarm cleans up a room whose host
 * vanished without a close, as on a deploy. Once its host token is too old to
 * open the ID again (tokenEnd), the room deletes everything it holds.
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
  // Deletes a kept room's images when it expires.
  private readonly removeKeptBlobs = () => this.deleteBlobs([this.blobPrefix(true)])

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Answered without waking the room, so a client can check that the room
    // still has its connection at no cost.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(RELAY_PING, RELAY_PONG))
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    // A connection is refused with a close code below, which the page shows.
    if (
      (await this.dropLegacyKept()) &&
      request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
    )
      return new Response('room has ended', { status: 410 })
    if (/\/keep(?:\/|$)/.test(path)) return this.keepRequest(request, path)
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
      return this.refuse(CLIENT_OUTDATED, 'pedit is outdated; update it', version.offered)
    }
    if (version.result === 'server-outdated') {
      return this.refuse(SERVER_OUTDATED, 'the server is older than this pedit', version.offered)
    }
    const token = readAdmissionProtocol(protocols)
    if (!token || version.result !== 'current')
      return new Response('room admission required; update your client', { status: 403 })
    const isHost = request.headers.get(HOST_HEADER) === '1'
    // Before anything that touches the room's state.
    const turnedAway = this.originGate(request, isHost, version.version)
    if (turnedAway) return turnedAway
    const join = this.joinFrom(request, version.version, isHost)
    // Only the host's headers count; the Worker does not vouch for them.
    const hostHeader = (name: string) => (isHost && request.headers.get(name)) || null
    const credentials: Credentials = {
      token,
      read: hostHeader(READ_ADMISSION_HEADER),
      comment: hostHeader(COMMENT_ADMISSION_HEADER),
      offered: version.version >= 8 ? commentAdmissionProtocol(protocols) : null,
    }
    if (
      [credentials.read, credentials.comment].some((t) => t !== null && !ADMISSION_PATTERN.test(t))
    ) {
      return new Response('invalid reader admission', { status: 403 })
    }
    // The hash below is an await during which an alarm may run. Counting the
    // host handshakes in flight keeps that alarm from cleaning up a session
    // whose host is just reconnecting.
    if (isHost) this.hostHandshakes++
    try {
      return await this.admit(credentials, isHost, join)
    } finally {
      if (isHost) this.hostHandshakes--
    }
  }

  // Refuses a host that declares origins the relay does not allow, and a page
  // whose origin the room has not admitted (the Worker sets the foreign header).
  private originGate(request: Request, isHost: boolean, version: number): Response | undefined {
    if (isHost && parseOrigins(request.headers.get(ORIGINS_HEADER)) === undefined) {
      return new Response('invalid origins', { status: 403 })
    }
    const foreign = request.headers.get(FOREIGN_ORIGIN_HEADER)
    if (foreign === null || (!isHost && this.origins().includes(foreign))) return undefined
    return this.refuse(ORIGIN_NOT_ALLOWED, ORIGIN_REFUSED_REASON, socketProtocol(version))
  }

  // The page origins the host admitted for this session.
  private origins(): string[] {
    return this.ctx.storage.kv.get<string[]>(ORIGINS_KEY) ?? []
  }

  // A request under /keep: the host's close of a room kept without it, the
  // status of a kept room, and a change of its keep.
  private keepRequest(request: Request, path: string): Promise<Response> | Response {
    if (path.endsWith('/keep/close') && request.method === 'POST' && this.awayRoom())
      return this.closeAway(request)
    if (path.endsWith('/keep') && (request.method === 'GET' || request.method === 'POST'))
      return this.keepStatus(request)
    return new Response(null, { status: 404 })
  }

  // GET /keep answers what the room will do; POST /keep first replaces the
  // keep, while the host is here, of a room opened with one.
  private keepStatus(request: Request): Response {
    if (request.headers.get(HOST_HEADER) !== '1') return new Response(null, { status: 403 })
    const kv = this.ctx.storage.kv
    // `endSession` is the one way a session ends (host left, close, expiry),
    // and it always deletes the admission key; a room that opened has one until
    // then. `expired()` also covers a room whose alarm has not run yet.
    if (
      this.openedAt() === undefined ||
      kv.get(ADMISSION_KEY) === undefined ||
      kv.get(CLOSED_KEY) === true ||
      kv.get(EXPIRED_KEY) === true ||
      this.expired()
    )
      return new Response(null, { status: 410 })
    if (request.method === 'POST') {
      const asked = this.keepFrom(request.headers.get(KEEP_HEADER))
      if (this.keptAway() || this.keepSeconds() === 0 || !asked)
        return new Response(null, { status: 409 })
      kv.put(KEEP_KEY, asked)
    }
    const keptUntil = kv.get<number>(KEPT_AWAY_KEY)
    return Response.json({
      keep: this.keepSeconds(),
      host: keptUntil === undefined ? 'here' : 'away',
      ends: Math.min(keptUntil ?? this.deadline(), this.lifeEnd()),
      lifeEnd: this.lifeEnd(),
    })
  }

  private joinFrom(request: Request, version: number, isHost: boolean): Join {
    // Keeping a room needs the kind bytes of version 6.
    const keeps = isHost && version >= 6
    return {
      version,
      protocol: socketProtocol(version),
      keep: keeps ? this.keepFrom(request.headers.get(KEEP_HEADER)) : undefined,
      origins: (isHost && parseOrigins(request.headers.get(ORIGINS_HEADER))) || [],
      issued: isHost ? wholeFrom(request.headers.get(ISSUED_HEADER)) : undefined,
      // A browser cannot set a header on a WebSocket: it sends `?after=` instead.
      after: wholeFrom(
        request.headers.get(AFTER_HEADER) ?? new URL(request.url).searchParams.get('after'),
      ),
    }
  }

  private async admit(credentials: Credentials, isHost: boolean, join: Join): Promise<Response> {
    const digests = await hashed(credentials)
    const digest = digests.token
    // A peer that joins after the host closed the room, or that was joining
    // again when it did, learns the reason the others got.
    if (this.ctx.storage.kv.get(CLOSED_KEY) === true)
      return this.refuse(ROOM_CLOSED, HOST_CLOSED_REASON, join.protocol)
    if (this.ctx.storage.kv.get('keptTextClosed') === true)
      return this.refuse(ROOM_EXPIRED, 'room has expired', join.protocol)
    // A version 5 host cannot take in the entries kept for it, and returning
    // would discard them: it is told to update, and the room stays kept.
    if (isHost && join.version === 5 && this.keptAway())
      return this.refuse(CLIENT_OUTDATED, 'pedit is outdated; update it', join.protocol)
    // Deploys can drop every socket without a close callback. Only a guest
    // with this session's editor admission may start its missing host grace
    // period: the reader token goes to anyone a link was passed on to.
    if (
      !isHost &&
      !this.expired() &&
      this.hosts().length === 0 &&
      this.awayUntil() === undefined &&
      !this.keptAway() &&
      this.role(digest) === 'editor'
    ) {
      await this.waitForHost()
    }
    // Nothing below awaits before the socket is accepted, so an alarm cannot
    // expire the room between these checks and the accept. An expired room
    // refuses everyone before admission, so it never registers a verifier again.
    // Clients released before ROOM_EXPIRED existed treat 4007 as an ordinary
    // drop and keep reconnecting (with backoff) to an expired room; accepted,
    // since the time limit is final for every current client.
    if (this.expired()) {
      if (this.sessionOpen()) await this.expire()
      return this.refuse(ROOM_EXPIRED, expiredReason(this.lifeSeconds()), join.protocol)
    }
    if (!isHost && this.hosts().length === 0 && !this.hostAway() && !this.keptAway()) {
      // A grace period that ran out with its alarm late.
      if (this.awayUntil() !== undefined) await this.closeAfterGrace()
      if (!this.keptAway()) {
        this.log('turned a guest away', { code: ROOM_CLOSED })
        return this.refuse(ROOM_CLOSED, 'room is closed', join.protocol)
      }
    }
    const unopenable = isHost && this.openedAt() === undefined && this.openRefusal(join)
    if (unopenable) return unopenable
    // Authenticate before taking a peer slot. Only the authenticated host may
    // register the verifiers; a guest cannot claim an unopened room's tokens.
    const role = isHost
      ? this.registerHost(digests, join.origins)
      : this.role(digest, join.version >= 8 ? digests.offered : null)
    if (!role) return new Response('invalid room admission', { status: 403 })
    this.closeOutdatedPeers()
    if (this.full(isHost, role)) return this.refuse(ROOM_FULL, 'room is full', join.protocol)
    return this.accept(isHost, role, join)
  }

  // A room kept over HTTP before that mode was removed (kv `keptText`) is torn
  // down: its snapshot, log and images go, and it answers as a room that ended
  // (`keptTextClosed` stays). Returns whether the room is one.
  private async dropLegacyKept(): Promise<boolean> {
    const storage = this.ctx.storage
    if (storage.kv.get('keptText') !== undefined) {
      storage.transactionSync(() => {
        storage.kv.delete('keptText')
        storage.kv.put('keptTextClosed', true)
        storage.sql.exec('DROP TABLE IF EXISTS kept_text_log')
      })
      await storage.deleteAlarm()
      await storage.sync()
      await this.removeKeptBlobs()
    }
    return storage.kv.get('keptTextClosed') === true
  }

  // A room opens only with a token the relay issued lately, so that its life
  // ends before the token is too old to open it again, and its tombstone can
  // go then. A token without a time reaches only rooms opened before.
  private openRefusal(join: Join): Response | undefined {
    const now = Date.now()
    if (join.issued === undefined || join.issued > now + ISSUE_SKEW_MS)
      return new Response('invalid host token', { status: 403 })
    if (now > join.issued + OPEN_WINDOW_MS)
      return this.refuse(ROOM_EXPIRED, 'room has expired', join.protocol)
    return undefined
  }

  // Takes a peer admitted to a place. Nothing awaits before the accept.
  private closeOutdatedPeers(): void {
    for (const peer of this.peers()) {
      if (!this.ctx.getTags(peer).includes(SOCKET_PROTOCOL))
        safeClose(peer, CLIENT_OUTDATED, 'pedit is outdated; update it')
    }
  }

  private async accept(isHost: boolean, role: Role, join: Join): Promise<Response> {
    const kv = this.ctx.storage.kv
    // The clock starts at the host's first connection and never again.
    const first = isHost && this.openedAt() === undefined
    // `openRefusal` made sure a first connection has its token's time.
    if (first) {
      kv.put(OPENED_KEY, Date.now())
      kv.put(ISSUED_KEY, join.issued)
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server, socketTags(isHost, role, join.version))
    const v6 = join.version >= 6
    if (isHost) {
      this.log('host connected')
      // Whether there is a keep is fixed at the first connection, before any
      // image is stored under the prefix it picks. A later connect may only
      // replace a positive keep with another positive one.
      if (first) kv.put(KEEP_KEY, join.keep ?? 0)
      else if (this.keepSeconds() > 0 && join.keep) kv.put(KEEP_KEY, join.keep)
      if (join.keep !== undefined) safeSend(server, `${KEEP} ${this.keepSeconds()} 0`)
      // The host returns to a room kept without it: it is sent what was
      // written, and the room is its own again.
      const kept = this.keptAway()
      if (kept) {
        kv.put(HOST_SINCE_KEY, Date.now())
        this.sendReplay(server, join.after, true)
      }
      if (this.awayUntil() !== undefined || kept) this.hostReturned()
      await this.ctx.storage.setAlarm(this.nextAlarm())
    } else if (this.keptAway()) {
      this.sendKept(server, kv.get<number>(KEPT_AWAY_KEY) ?? 0)
      if (v6) this.sendReplay(server, join.after, false)
    } else if (this.hostAway()) {
      safeSend(server, HOST_AWAY)
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': join.protocol },
    })
  }

  // Tells a peer the room is kept until then: a version 5 peer reads it as a
  // host that is away. A version 8 peer is also told the relay takes comment
  // entries, if the host registered the comment token.
  private sendKept(peer: WebSocket, until: number): void {
    const tags = this.ctx.getTags(peer)
    if (!tags.includes(V6_TAG)) {
      safeSend(peer, HOST_AWAY)
      return
    }
    safeSend(peer, `${KEPT} ${until}`)
    if (tags.includes(V8_TAG) && this.ctx.storage.kv.get(COMMENT_ADMISSION_KEY) !== undefined)
      safeSend(peer, KEPT_COMMENTS)
  }

  // The snapshot, the entries and the tail of a room kept without its host.
  private sendReplay(ws: WebSocket, after: number | undefined, host: boolean): void {
    for (const message of replay(this.ctx.storage, after, host)) {
      try {
        ws.send(message)
      } catch {
        // Going away; its close handler cleans up.
      }
    }
  }

  // The keep a host asks for: whole seconds, no more than the relay allows.
  private keepFrom(header: string | null): number | undefined {
    if (header === null) return undefined
    const max = Number(
      'KEEP_MAX_SECONDS' in this.env && typeof this.env.KEEP_MAX_SECONDS === 'string'
        ? this.env.KEEP_MAX_SECONDS
        : KEEP_DEFAULT_MAX_SECONDS,
    )
    const asked = /^\d{1,10}$/.test(header) ? Number(header) : 0
    return Math.min(asked, Number.isSafeInteger(max) && max > 0 ? max : 0)
  }

  private keepSeconds(): number {
    return this.ctx.storage.kv.get<number>(KEEP_KEY) ?? 0
  }

  // Whether the room is kept without its host.
  private keptAway(): boolean {
    return this.ctx.storage.kv.get<number>(KEPT_AWAY_KEY) !== undefined
  }

  // Whether the host's leaving can keep the room: it asked, and left a snapshot.
  private canKeep(): boolean {
    return this.keepSeconds() > 0 && !this.expired() && hasSnapshot(this.ctx.storage)
  }

  // Whether the room is, or was, one the host has left: for POST /keep/close.
  private awayRoom(): boolean {
    return this.keptAway() || this.ctx.storage.kv.get(CLOSED_KEY) === true
  }

  // The host ends a room kept without it. Like the HTTP kept room's close, it
  // names the last entry it took in, and an edit that came later keeps the room open.
  private async closeAway(request: Request): Promise<Response> {
    if (request.headers.get(HOST_HEADER) !== '1') return new Response(null, { status: 403 })
    if (this.keptAway()) {
      if (request.headers.get('X-Pedit-Tail') !== String(awayLog(this.ctx.storage).tail))
        return new Response(null, { status: 409 })
      this.ctx.storage.kv.put(CLOSED_KEY, true)
      await this.endSession(ROOM_CLOSED, HOST_CLOSED_REASON)
    }
    return Response.json({})
  }

  /**
   * Which admission token a digest is, hashed before this runs: the editors'
   * or the readers' (a comment-only or read-only link). The relay uses it
   * only to keep places and uploads for editors; what anyone may change in
   * the room, every peer checks by signatures it cannot see.
   */
  private role(digest: ArrayBuffer, offeredComment: ArrayBuffer | null = null): Role | null {
    const kv = this.ctx.storage.kv
    const editor = kv.get<ArrayBuffer>(ADMISSION_KEY)
    if (editor && crypto.subtle.timingSafeEqual(editor, digest)) return 'editor'
    const reader = kv.get<ArrayBuffer>(READ_ADMISSION_KEY)
    if (!reader || !crypto.subtle.timingSafeEqual(reader, digest)) return null
    // A comment token that does not match, or a room without one, leaves a reader.
    const comment = kv.get<ArrayBuffer>(COMMENT_ADMISSION_KEY)
    const commenter =
      offeredComment && comment && crypto.subtle.timingSafeEqual(comment, offeredComment)
    return commenter ? 'commenter' : 'reader'
  }

  /**
   * Checks the host's editor token against the session's, or registers both
   * tokens when it has none. Persisted across hibernation, and read after
   * hashing so concurrent host handshakes cannot each install other tokens.
   */
  private registerHost(digests: Digests, origins: string[]): Role | null {
    const kv = this.ctx.storage.kv
    const expected = kv.get<ArrayBuffer>(ADMISSION_KEY)
    if (expected) return crypto.subtle.timingSafeEqual(expected, digests.token) ? 'editor' : null
    kv.put(ADMISSION_KEY, digests.token)
    if (digests.read) kv.put(READ_ADMISSION_KEY, digests.read)
    if (digests.comment) kv.put(COMMENT_ADMISSION_KEY, digests.comment)
    if (origins.length > 0) kv.put(ORIGINS_KEY, origins)
    return 'editor'
  }

  /**
   * Whether the room has no place for a newcomer. Readers count apart from
   * everyone else, even against MAX_PEERS, so they cannot take editors'
   * places.
   */
  private full(isHost: boolean, role: Role): boolean {
    const { guests, readers } = limits(this.env)
    const peers = this.peers().filter((peer) => this.ctx.getTags(peer).includes(SOCKET_PROTOCOL))
    const reading = peers.filter((peer) => this.ctx.getTags(peer).includes(READER_TAG)).length
    if (role !== 'editor') return reading >= readers
    const editing = peers.length - reading
    if (editing >= MAX_PEERS) return true
    if (isHost) return false
    return editing - peers.filter((peer) => this.isHost(peer)).length >= guests
  }

  private openedAt(): number | undefined {
    return this.ctx.storage.kv.get<number>(OPENED_KEY)
  }

  // The end of the room's whole life, or Infinity before its host came.
  private lifeEnd(): number {
    const opened = this.openedAt()
    if (opened === undefined) return Number.POSITIVE_INFINITY
    return opened + limits(this.env).lifeSeconds * 1000
  }

  // The end of the host's session, or the end of the room's life if sooner;
  // Infinity before its host came. A kept room has no session: only its keep counts.
  private deadline(): number {
    const since = this.ctx.storage.kv.get<number>(HOST_SINCE_KEY) ?? this.openedAt()
    if (since === undefined) return Number.POSITIVE_INFINITY
    return Math.min(since + limits(this.env).roomSeconds * 1000, this.lifeEnd())
  }

  // What the close reason says the room lasts: its whole life if that is what
  // ended it, else the keep for a kept room, else the session limit (the keep
  // when the relay sets none).
  private lifeSeconds(): number {
    const { roomSeconds, lifeSeconds } = limits(this.env)
    if (Date.now() >= this.lifeEnd()) return lifeSeconds
    return Number.isFinite(roomSeconds) && !this.keptAway() ? roomSeconds : this.keepSeconds()
  }

  // Date.now() rather than the `now` seam: the tests stop that one at 0.
  private expired(): boolean {
    const keptUntil = this.ctx.storage.kv.get<number>(KEPT_AWAY_KEY)
    return (
      Date.now() >= Math.min(keptUntil ?? this.deadline(), this.lifeEnd()) ||
      this.ctx.storage.kv.get(EXPIRED_KEY) === true
    )
  }

  // The hourly check, or the deadline or the end of a grace period if one
  // comes sooner. A room kept without its host is checked at the end of its keep only.
  private nextAlarm(): number {
    const keptUntil = this.ctx.storage.kv.get<number>(KEPT_AWAY_KEY)
    if (keptUntil !== undefined) return Math.min(keptUntil, this.lifeEnd())
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
    return this.ctx.storage.kv.get(ADMISSION_KEY) !== undefined || this.peers().length > 0
  }

  /**
   * Alarms are at-least-once and may come late, so this does only what is
   * still needed and can run twice.
   */
  override async alarm(): Promise<void> {
    if (this.purgeDue()) {
      await this.purge()
      return
    }
    await this.check()
    await this.armPurge()
  }

  private async check(): Promise<void> {
    if (await this.dropLegacyKept()) return

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
      if (this.hostAway() || this.keptAway()) {
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
        // A host that asked to keep the room gets its grace period, then the
        // kept state, as if its close had been seen.
        if (this.canKeep()) await this.waitForHost()
        else await this.endSession(ROOM_CLOSED, 'the host left')
      }
      return
    }
    await this.ctx.storage.setAlarm(this.nextAlarm())
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.refused(ws)) return
    if (!this.ctx.getTags(ws).includes(SOCKET_PROTOCOL)) {
      safeClose(ws, CLIENT_OUTDATED, 'pedit is outdated; update it')
      return
    }
    if (typeof message === 'string') {
      this.closePeer(ws, 1003, 'binary frames only')
      return
    }
    // A version 6 message has the kind byte, and a checkpoint a cutoff, besides.
    const v6 = this.ctx.getTags(ws).includes(V6_TAG)
    if (message.byteLength > MAX_FRAME_BYTES + (v6 ? 9 : 0)) {
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
      for (const peer of this.ctx.getWebSockets()) {
        safeClose(peer, RELAY_MAINTENANCE, 'closed for maintenance')
      }
      return
    }
    if (!this.allow(ws, message.byteLength)) {
      this.closePeer(ws, RATE_LIMITED, 'rate limited')
      return
    }
    const bytes = new Uint8Array(message)
    // A version 5 peer has no kind byte: all it sends is live.
    if (!v6) {
      this.fan(ws, withKind(Kind.Live, bytes), bytes)
      return
    }
    const split = splitKind(bytes)
    if (!split) {
      this.closePeer(ws, 1003, 'empty message')
      return
    }
    this.byKind(ws, bytes, split.kind, split.payload)
  }

  // What the relay does with a message of a kind (docs/design/rooms-away.md).
  private byKind(ws: WebSocket, wire: Uint8Array, kind: number, payload: Uint8Array): void {
    if (payload.length > MAX_FRAME_BYTES + (kind === Kind.Checkpoint ? 8 : 0)) {
      this.closePeer(ws, MESSAGE_TOO_BIG, 'message too big')
      return
    }
    const host = this.isHost(ws)
    switch (kind) {
      case Kind.Live:
        this.fan(ws, wire, payload)
        return
      case Kind.Entry:
        this.entry(ws, wire, payload)
        return
      case Kind.Snapshot:
      case Kind.Checkpoint:
        this.fromHost(ws, host, kind, payload)
        return
      case Kind.Logged:
      case Kind.Replay:
      case Kind.LogEnd:
        // Only the relay sends these.
        this.closePeer(ws, 1003, 'not for the relay')
        return
      default:
      // A kind of a later version: ignored, as a peer ignores it.
    }
  }

  // A kind 1 entry: an editor's or a commenter's; a reader's link cannot write.
  private entry(ws: WebSocket, wire: Uint8Array, payload: Uint8Array): void {
    const tags = this.ctx.getTags(ws)
    const commenter = tags.includes(COMMENTER_TAG)
    if ((tags.includes(READER_TAG) && !commenter) || payload.length === 0) {
      this.closePeer(ws, RATE_LIMITED, 'readers write no entries')
    } else if (!this.keptAway()) {
      // The host is here, and takes the entry in like a live update.
      this.fan(ws, wire)
    } else {
      const id = appendEntry(this.ctx.storage, payload, commenter)
      if (id === undefined) safeSend(ws, LOG_FULL)
      // To the writer too: the entry coming back with its id is its acknowledgement.
      else this.fan(null, encodeLogged(id, payload))
    }
  }

  // Kinds 2 and 3, which only the host may send, and only a room it asked to keep stores.
  private fromHost(ws: WebSocket, host: boolean, kind: number, payload: Uint8Array): void {
    if (!host) {
      this.closePeer(ws, RATE_LIMITED, 'only the host keeps a snapshot')
      return
    }
    if (this.keepSeconds() === 0) return
    if (kind === Kind.Snapshot) {
      if (payload.length > 0) storeSnapshot(this.ctx.storage, payload)
      return
    }
    const cp = decodeCheckpoint(payload)
    if (!cp || cp.bundle.length === 0) {
      this.closePeer(ws, 1003, 'invalid checkpoint')
      return
    }
    const done = checkpoint(this.ctx.storage, cp.cutoff, cp.bundle)
    safeSend(ws, done ? `${CHECKPOINT} ${done.cutoff} ${done.tail}` : CHECKPOINT_REFUSED)
  }

  // Sends a message to every peer but `from`: a version 6 peer gets `wire`, a
  // version 5 peer `plain`, or nothing if there is none (it knows no such kind).
  private fan(from: WebSocket | null, wire: Uint8Array, plain?: Uint8Array): void {
    const v6 = new Set(this.ctx.getWebSockets(V6_TAG))
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === from) continue
      const data = v6.has(peer) ? wire : plain
      if (!data) continue
      try {
        peer.send(data)
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
    if (this.refused(ws)) return
    if (this.isHost(ws))
      this.log('host closed', { code, wasClean, otherHosts: this.hosts(ws).length })
    await this.closeIfHostLeft(ws, code)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    safeClose(ws, 1011, 'error')
    if (this.refused(ws)) return
    if (this.isHost(ws)) this.log('host errored', { otherHosts: this.hosts(ws).length })
    await this.closeIfHostLeft(ws, 1011)
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
        guests: this.peers().length - hosts,
        openSeconds: opened === undefined ? null : Math.round((Date.now() - opened) / 1000),
        ...fields,
      }),
    )
  }

  /**
   * Refuses an upgrade with a close code, as `refuse` does, but with the
   * socket accepted by the hibernation API: the runtime logs an uncaught
   * "Network connection lost" error whenever a socket accepted the old way is
   * closed (workerd#5290), and a refusal is the one close this object makes
   * on purpose. The tag keeps the handlers off it.
   */
  private refuse(code: number, reason: string, protocol?: string): Response {
    return refuse(code, reason, protocol, (server) =>
      this.ctx.acceptWebSocket(server, [REFUSED_TAG]),
    )
  }

  private refused(ws: WebSocket): boolean {
    return this.ctx.getTags(ws).includes(REFUSED_TAG)
  }

  // The peers in the room: a socket accepted only to be refused, which the
  // runtime may still list while its close handshake is pending, takes no place.
  private peers(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => !this.refused(ws))
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
    const closed = maintenance(this.env as { MAINTENANCE?: string }) === 'closed'
    if (code === HOST_LEFT || closed) {
      // A host that asked for it leaves the room kept, if it left a snapshot.
      if (code === HOST_LEFT && !closed && this.canKeep()) {
        await this.enterKeptAway(ws)
        return
      }
      await this.endSession(ROOM_CLOSED, 'the host left', ws)
      return
    }
    if (this.hosts(ws).length > 0 || this.awayUntil() !== undefined || this.keptAway()) return
    await this.waitForHost()
  }

  /**
   * The host is away and the room stays: until the keep runs out, peers
   * write entries to a log that the host takes in when it comes back. Nobody
   * is closed, but for the host's own other connections. A room kept without
   * a snapshot cannot be: it ends as one that was not asked to be kept.
   */
  private async enterKeptAway(except?: WebSocket): Promise<void> {
    const kv = this.ctx.storage.kv
    // The keep counts from the host's leaving, but not beyond the room's life
    // (canKeep refuses a room already past it).
    const until = Math.min(Date.now() + this.keepSeconds() * 1000, this.lifeEnd())
    kv.put(KEPT_AWAY_KEY, until)
    kv.delete(AWAY_KEY)
    this.log('kept away', { untilSeconds: Math.round((until - Date.now()) / 1000) })
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === except) continue
      if (this.isHost(peer)) safeClose(peer, ROOM_CLOSED, 'the host left')
      else this.sendKept(peer, until)
    }
    await this.ctx.storage.setAlarm(this.nextAlarm())
  }

  // The last host dropped: wait for it to come back, without editing.
  private async waitForHost(): Promise<void> {
    // The session ended already (it expired, or the host left on purpose):
    // this is its last host closing.
    if (this.ctx.storage.kv.get(ADMISSION_KEY) === undefined || this.keptAway()) return
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
    // The log stays until the host checkpoints what it took in.
    this.ctx.storage.kv.delete(KEPT_AWAY_KEY)
    this.log('host returned')
    for (const peer of this.ctx.getWebSockets()) {
      if (!this.isHost(peer)) safeSend(peer, HOST_BACK)
    }
  }

  private async closeAfterGrace(): Promise<void> {
    this.log('host did not come back')
    if (this.canKeep()) {
      await this.enterKeptAway()
      return
    }
    await this.endSession(ROOM_CLOSED, 'the host left')
  }

  // The room reached its time limit: everyone goes, with the session's data.
  // Its `openedAt` stays, so the room ID is never opened again.
  private async expire(): Promise<void> {
    // Remembered, so the ID is not opened again.
    this.ctx.storage.kv.put(EXPIRED_KEY, true)
    await this.endSession(ROOM_EXPIRED, expiredReason(this.lifeSeconds()))
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
    this.generation++
    this.ctx.storage.kv.delete(USAGE_KEY)
    this.ctx.storage.kv.delete(ADMISSION_KEY)
    this.ctx.storage.kv.delete(READ_ADMISSION_KEY)
    this.ctx.storage.kv.delete(ORIGINS_KEY)
    this.ctx.storage.kv.delete(COMMENT_ADMISSION_KEY)
    this.ctx.storage.kv.delete(AWAY_KEY)
    this.ctx.storage.kv.delete(KEPT_AWAY_KEY)
    clearAway(this.ctx.storage)
    this.cleaning = this.cleaning.then(() => this.deleteBlobs())
    await this.cleaning
    await this.armPurge()
  }

  // When the room deletes everything it holds; undefined for a room never
  // opened, or opened with a token without a time.
  private purgeAt(): number | undefined {
    const issued = this.ctx.storage.kv.get<number>(ISSUED_KEY)
    return issued === undefined ? undefined : tokenEnd(issued, limits(this.env).lifeSeconds)
  }

  private purgeDue(): boolean {
    const at = this.purgeAt()
    return at !== undefined && Date.now() >= at
  }

  // A room with nothing left to check waits for its purge. An alarm already
  // set comes sooner, and the alarm that follows it arms this again.
  private async armPurge(): Promise<void> {
    const at = this.purgeAt()
    if (at === undefined || (await this.ctx.storage.getAlarm()) !== null) return
    await this.ctx.storage.setAlarm(at)
  }

  // The token can no longer open the ID again, so the tombstone is no longer
  // needed: the room deletes all it holds, and a host that comes with the
  // token finds a room it may not open.
  private async purge(): Promise<void> {
    // The room's life ended before; this closes anyone a late alarm left.
    if (this.sessionOpen()) await this.expire()
    this.log('room purged')
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  // A blob request from a page on another origin gets CORS headers if the
  // room admits it, and none (so the browser blocks the answer) if not.
  private async blob(request: Request, id: string): Promise<Response> {
    const foreign = request.headers.get(FOREIGN_ORIGIN_HEADER)
    if (foreign === null) return this.blobResponse(request, id)
    if (!this.origins().includes(foreign))
      return new Response('origin not allowed', { status: 403 })
    if (request.method === 'OPTIONS') return preflight(foreign)
    const answer = await this.blobResponse(request, id)
    const res = new Response(answer.body, answer)
    for (const [name, value] of Object.entries(corsHeaders(foreign))) res.headers.set(name, value)
    return res
  }

  private async blobResponse(request: Request, id: string): Promise<Response> {
    const token = request.headers.get(ADMISSION_HEADER)
    if (!token || !ADMISSION_PATTERN.test(token))
      return new Response('room admission required', { status: 403 })
    // Another session may end while we wait, chaining a newer cleanup.
    let cleaning: Promise<void>
    do {
      cleaning = this.cleaning
      await cleaning
    } while (cleaning !== this.cleaning)
    const role = await this.blobRole(request.method, token)
    if (role instanceof Response) return role
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

  // What the token may do with the room's blobs, or the refusal.
  private async blobRole(method: string, token: string): Promise<Role | Response> {
    const refused = () => new Response('invalid room admission', { status: 403 })
    if (this.expired()) return new Response('room has expired', { status: 410 })
    // A room kept without its host keeps serving its images and takes new ones.
    if (this.hosts().length === 0 && !this.keptAway()) {
      if (!this.hostAway()) return new Response('room is closed', { status: 410 })
      // What was attached can still be seen; nothing new goes in.
      if (method !== 'GET') return new Response('the host is away', { status: 503 })
    }
    // Hashed first, so the verifier is read after any await.
    return this.role(await sha256(token)) ?? refused()
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
    const kept = key.startsWith('kept/')
    const ended = () => this.generation !== generation || (kept && this.keepSeconds() === 0)
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
  private async deleteBlobs(prefixes = [this.blobPrefix()]): Promise<void> {
    try {
      for (const prefix of prefixes) {
        let cursor: string | undefined
        do {
          const page = await this.env.BLOBS.list({ prefix, cursor })
          if (page.objects.length > 0) await this.env.BLOBS.delete(page.objects.map((o) => o.key))
          cursor = page.truncated ? page.cursor : undefined
        } while (cursor)
      }
    } catch (error) {
      console.error('failed to delete blobs', error)
    }
  }

  // The Durable Object id is derived from the room id, and only this room knows it.
  // A kept room's blobs, and those of a room its host asked to keep, live under
  // their own prefix, which the bucket's one-day lifecycle rule for `rooms/`
  // leaves alone (docs/public-relay.md).
  private blobPrefix(kept = this.keepsBlobs()): string {
    return `${kept ? 'kept' : 'rooms'}/${this.ctx.id.toString()}/`
  }

  private keepsBlobs(): boolean {
    return this.keepSeconds() > 0
  }

  private usage(): Usage {
    return this.ctx.storage.kv.get<Usage>(USAGE_KEY) ?? { bytes: 0, count: 0 }
  }

  private setUsage(usage: Usage): void {
    this.ctx.storage.kv.put(USAGE_KEY, usage)
  }
}

// A whole number from a header (the entry a peer last held, the issue time
// of the host's token), or none.
function wholeFrom(header: string | null): number | undefined {
  return header !== null && /^\d{1,15}$/.test(header) ? Number(header) : undefined
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

// The tags of an accepted socket. SOCKET_PROTOCOL marks every socket this
// deployment accepted, whatever version it negotiated.
function socketTags(isHost: boolean, role: Role, version: number): string[] {
  const tags = [V6_TAG, SOCKET_PROTOCOL]
  if (version >= 8) tags.push(V8_TAG)
  if (isHost) tags.push(HOST_TAG)
  else if (role !== 'editor') tags.push(READER_TAG)
  if (role === 'commenter') tags.push(COMMENTER_TAG)
  return tags
}

/**
 * Accepts an upgrade only to close it with a reason: browsers cannot read
 * HTTP errors of a failed upgrade, but they do see close codes. `protocol` is
 * one the client offered, or the handshake would fail before the close.
 */
export function refuse(
  code: number,
  reason: string,
  protocol = SOCKET_PROTOCOL,
  accept: (server: WebSocket) => void = (server) => server.accept(),
): Response {
  const { 0: client, 1: server } = new WebSocketPair()
  accept(server)
  server.close(code, reason)
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { 'Sec-WebSocket-Protocol': protocol },
  })
}
