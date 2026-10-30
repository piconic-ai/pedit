import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import type * as Y from 'yjs'
import type { Access, RoomKeys } from './access.ts'
import { admissionProtocols } from './admission.ts'
import {
  type Attachment,
  decodeAttachment,
  encodeAttachment,
  UnknownAttachmentKindError,
} from './attachment.ts'
import { type CanvasMessage, decodeCanvas, encodeCanvas, UnknownCanvasKindError } from './canvas.ts'
import { decrypt, encrypt } from './cipher.ts'
import {
  CLIENT_OUTDATED,
  HOST_AWAY,
  HOST_BACK,
  MESSAGE_TOO_BIG,
  parseExpiredReason,
  RELAY_BUSY,
  RELAY_MAINTENANCE,
  ROOM_CLOSED,
  ROOM_EXPIRED,
  ROOM_FULL,
  SERVER_OUTDATED,
} from './close.ts'
import {
  decodeFiles,
  encodeFileDoc,
  encodeManifest,
  type FileEntry,
  MAX_FILE_ID,
  UnknownFilesKindError,
} from './files.ts'
import {
  decodeFrame,
  encodeFrame,
  frameBytes,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  ReplayedFrameError,
  ReplayGuard,
  SENDER_BYTES,
} from './frame.ts'
import {
  decodeFresh,
  encodeFresh,
  type FreshMessage,
  Freshness,
  RESEND_EVERY_MS,
  SETTLE_AFTER_MS,
} from './fresh.ts'
import { KeptAway, type KeptSync } from './kept-away-client.ts'
import { Kind, parseNumbers, splitKind, withKind } from './kinds.ts'
import {
  decodeMessage,
  encodeMessage,
  type Message,
  MessageType,
  UnknownMessageTypeError,
} from './message.ts'
import { Pacer, type Rate } from './pace.ts'
import {
  ANNOUNCE_EVERY_MS,
  decodeAwarenessEntry,
  encodeAwarenessEntry,
  MAX_WIRE_CLOCK,
  Presence,
} from './presence.ts'
import { openMessage, signMessage } from './signed.ts'

/**
 * `closed` is final: the host ended the session. So is `full`: the room had no
 * place for us. So is `maintenance`: the relay closed, and whether to come
 * back is up to the person. So are `client-outdated` and `server-outdated`:
 * the server speaks an older or newer protocol version. So is `too-large`: a
 * frame we had to send was over MAX_FRAME_BYTES, the most the relay takes.
 * So is `expired`: the room reached the relay's time limit.
 * `busy` is not: the relay turned us away for now, and the client tries again
 * later than after a drop. Nor is `waiting`: we are connected, but the host
 * dropped and the relay waits for it to come back; nobody edits meanwhile.
 * `kept` is a room whose host is away on purpose, or for good, and which the
 * relay keeps (docs/design/rooms-away.md): edits go to its log, until
 * `keptUntil`. `log-full` is that room refusing edits, its log being full.
 */
export type RoomStatus =
  | 'connecting'
  | 'connected'
  | 'waiting'
  | 'kept'
  | 'log-full'
  | 'disconnected'
  | 'busy'
  | 'closed'
  | 'full'
  | 'maintenance'
  | 'client-outdated'
  | 'server-outdated'
  | 'too-large'
  | 'expired'

/** Whether a client stays in this status for good and no longer reconnects. */
export function isFinalStatus(status: RoomStatus): boolean {
  return (
    status === 'closed' ||
    status === 'full' ||
    status === 'maintenance' ||
    status === 'client-outdated' ||
    status === 'server-outdated' ||
    status === 'too-large' ||
    status === 'expired'
  )
}

/** The status each final close code leaves a client in. */
const FINAL_CLOSE: ReadonlyMap<number, RoomStatus> = new Map([
  [ROOM_CLOSED, 'closed'],
  [ROOM_FULL, 'full'],
  [RELAY_MAINTENANCE, 'maintenance'],
  [CLIENT_OUTDATED, 'client-outdated'],
  [SERVER_OUTDATED, 'server-outdated'],
  [MESSAGE_TOO_BIG, 'too-large'],
  [ROOM_EXPIRED, 'expired'],
])

/** The subset of the WebSocket API used by RoomClient (browser and Node.js 22+ globals both fit). */
export interface SocketLike {
  binaryType: string
  readonly readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: Uint8Array): void
  close(code?: number, reason?: string): void
}

export interface RoomClientOptions {
  /** WebSocket URL of the room. Must never contain the key. */
  url: string
  /** What the client's link gives in this room (access.ts). */
  keys: RoomKeys
  admissionToken: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  /** Extra handshake headers (Node.js only; browsers cannot set them). */
  headers?: Record<string, string>
  createSocket?: (url: string, headers?: Record<string, string>, protocols?: string[]) => SocketLike
  minBackoffMs?: number
  maxBackoffMs?: number
  /** The least a busy relay is waited out before trying again. */
  busyBackoffMs?: number
  onStatus?: (status: RoomStatus) => void
  /** While the room is kept: whether the relay has logged all of this client's edits. */
  onKeptSync?: (state: KeptSync) => void
  /** How many entries of the kept room did not hold, and were left out, in all. */
  onKeptSkipped?: (count: number) => void
  onError?: (error: unknown) => void
  onAttachment?: (attachment: Attachment) => void
  onCanvas?: (message: CanvasMessage) => void
  /**
   * A peer's access rose (see accessOf). Its state may be the same as
   * before, so the awareness says nothing of it.
   */
  onAccess?: (clientId: number) => void
  /**
   * In a room that shares several files (see addFile): each list of the
   * room's files, once per added file the first SyncStep2 for it, and the
   * messages about one file.
   */
  onManifest?: (files: FileEntry[]) => void
  onFileSynced?: (file: number) => void
  onFileAttachment?: (file: number, attachment: Attachment) => void
  onFileCanvas?: (file: number, message: CanvasMessage) => void
  /** What the relay lets one connection send; RELAY_MESSAGE_RATE and RELAY_BYTE_RATE by default. */
  messageRate?: Rate
  byteRate?: Rate
}

/** A file's Y.Doc that a RoomClient keeps in sync. */
interface FileDoc {
  doc: Y.Doc
  check?: UpdateCheck
  /** Whether commenters write this doc: a file's comments, not the file. */
  comments: boolean
  onUpdate: (update: Uint8Array, origin: unknown) => void
  synced: boolean
  /** When the client may next ask the room for what a check refused, and the timer that will. */
  resyncAt: number
  resyncTimer: ReturnType<typeof setTimeout> | null
}

/** The ms checking and applying updates may still take, as of `counted`. */
interface TimeShare {
  credit: number
  counted: number
}

/**
 * Tells why an update received for `doc` must not be applied, or returns
 * null. See addFile.
 */
export type UpdateCheck = (doc: Y.Doc, update: Uint8Array) => Refusal | null

/**
 * Why a check refused an update. With `retryLater`, it is refused for now
 * only, such as one that needs updates not received yet: the client sends
 * the room a sync step 1 for the file then, at most every RESYNC_EVERY_MS,
 * so an honest peer's updates come back whole.
 */
export interface Refusal {
  reason: string
  retryLater?: boolean
}

/**
 * A frame its sender's access does not allow (#122): a write from a peer
 * that may only read it, or a message only editors send. Dropped.
 */
export class NotAllowedError extends Error {
  constructor(what: string, access: Access) {
    super(`dropped ${what} from a peer with ${access} access`)
    this.name = 'NotAllowedError'
  }
}

/**
 * Checking and applying the updates of all checked files together may take
 * a quarter of the time, with up to a second in hand, so a peer flooding the
 * room cannot keep the client checking; an update past that is refused for
 * now. As internal/protocol does.
 */
const CHECK_SHARE = 4
const CHECK_BURST_MS = 1000
const RESYNC_EVERY_MS = 5000
/**
 * A client that set a manifest sends it again to someone who asks for file 0
 * (a SyncStep1), as every newcomer does, at most this often: awareness does
 * not tell of all of them, as a client follows only so many that sign
 * nothing.
 */
const MANIFEST_EVERY_MS = 2000

const OPEN = 1
/** The relay's word that an entry did not fit its log. */
const LOG_FULL = 'log full'

/**
 * Keeps a Y.Doc and Awareness in sync with every other peer in a room.
 *
 * The server is a dumb relay, so the peers run a symmetric protocol: on connect a
 * peer sends SyncStep1 (to pull what it is missing), its full state as an update
 * (to push what others are missing) and its awareness state. Every peer answers
 * SyncStep1 with SyncStep2. All frames are end-to-end encrypted.
 *
 * What a peer may change follows from its link (access.ts): editors sign
 * their frames with the editors' key, commenters with the commenters' key,
 * and readers sign nothing. Every peer applies a frame only as far as the
 * key that signed it allows, and a client sends only what its own access
 * lets others apply.
 */
export class RoomClient {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  status: RoomStatus = 'disconnected'
  /** The relay's time limit in seconds, when it said so on closing an expired room. */
  timeLimitSeconds: number | undefined

  private readonly opts: RoomClientOptions
  private readonly kept: KeptAway
  // Whether the relay has sent anything on this connection yet.
  private heard = false
  private socket: SocketLike | null = null
  private attempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private sendChain: Promise<void> = Promise.resolve()
  private receiveChain: Promise<void> = Promise.resolve()
  // Who we are on the frames we send, and how many we numbered (frame.ts).
  private readonly sender = globalThis.crypto.getRandomValues(new Uint8Array(SENDER_BYTES))
  private sent = 0
  private readonly guard = new ReplayGuard(this.sender)
  // This client's side of the handshake that shows peers are live
  // (fresh.ts), when it last sent its state again for peers that dropped
  // it, and the timer that sends it again.
  private readonly fresh = new Freshness()
  private resentAt = Number.NEGATIVE_INFINITY
  private resendTimer: ReturnType<typeof setTimeout> | null = null
  private resendState = false
  // What this client sends once, held after connecting until it settles
  // (fresh.ts), and the timer that settles it.
  private settled = false
  private held: { type: MessageType; payload: Uint8Array }[] = []
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private readonly files = new Map<number, FileDoc>()
  /** The time checked files' updates may take, as CHECK_SHARE says. */
  private readonly checks: TimeShare = { credit: CHECK_BURST_MS, counted: performance.now() }
  // Paces the frames sent on the current socket; see Pacer.
  private pacer = new Pacer()
  // Ends the pacing wait of the frame next in line, when its socket closes.
  private wake: (() => void) | null = null
  // The encoded manifest, when this client set one, when it was last sent
  // to someone who asked for file 0, and the timer that sends it again.
  private manifest: Uint8Array | null = null
  private manifestAt = Number.NEGATIVE_INFINITY
  private manifestTimer: ReturnType<typeof setTimeout> | null = null
  // The access each awareness client ID spoke with (presence.ts).
  private readonly presence = new Presence()
  // When this client last sent its state to newcomers, and the timer that
  // sends it again.
  private announcedAt = Number.NEGATIVE_INFINITY
  private announceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: RoomClientOptions) {
    this.opts = opts
    this.doc = opts.doc
    this.awareness = opts.awareness
    this.kept = new KeptAway(opts.keys, this, {
      docs: () => [[0, { doc: this.doc, comments: false }], ...this.files],
      entry: (id, update) => this.sendEntry(id, update),
      manifest: (files) => opts.onManifest?.(files),
      sync: (state) => opts.onKeptSync?.(state),
      skipped: (count) => opts.onKeptSkipped?.(count),
    })
    this.doc.on('update', this.handleDocUpdate)
    this.awareness.on('update', this.handleAwarenessUpdate)
    this.awareness.on('change', this.handleAwarenessChange)
  }

  /** When the relay stops keeping the room, in ms since the epoch, while the host is away. */
  get keptUntil(): number {
    return this.kept.until
  }

  connect(): void {
    if (this.destroyed || this.socket) return
    this.setStatus('connecting')
    const createSocket = this.opts.createSocket ?? defaultCreateSocket
    const socket = createSocket(
      this.socketUrl(),
      this.opts.headers,
      admissionProtocols(this.opts.admissionToken),
    )
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    // The relay counts each connection's allowance from its start.
    this.pacer = new Pacer(this.opts.messageRate, this.opts.byteRate)

    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempts = 0
      // Told again by the relay, if the room is kept.
      this.kept.active = false
      this.heard = false
      this.greet(socket)
    }
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return
      const heard = this.heard
      this.heard = true
      if (typeof ev.data === 'string') {
        this.relayText(ev.data, socket, heard)
        return
      }
      const bytes = toBytes(ev.data)
      // Version 6: a live frame has kind 0. The other kinds are those of a
      // room kept while its host is away (kept-away-client.ts).
      const split = bytes && splitKind(bytes)
      if (!split) return
      const { kind, payload: data } = split
      if (kind !== Kind.Live) {
        this.receiveChain = this.receiveChain
          .then(() => this.kept.receive(kind, data))
          .catch((error) => this.opts.onError?.(error))
        return
      }
      this.receiveChain = this.receiveChain
        .then(() => this.receive(data))
        .catch((error) => this.opts.onError?.(error))
    }
    socket.onclose = (ev) => {
      if (this.socket !== socket) return
      this.socket = null
      // Its frames are dropped: the next connection need not wait them out.
      this.wake?.()
      this.dropRemoteAwareness()
      const final = ev.code === undefined ? undefined : FINAL_CLOSE.get(ev.code)
      if (final && !this.destroyed) {
        if (final === 'expired') this.timeLimitSeconds = parseExpiredReason(ev.reason)
        this.setStatus(final)
        return
      }
      if (ev.code === RELAY_BUSY) {
        this.setStatus('busy')
        this.scheduleReconnect(this.opts.busyBackoffMs ?? 10_000)
        return
      }
      this.setStatus('disconnected')
      this.scheduleReconnect()
    }
    socket.onerror = (error) => {
      this.opts.onError?.(error)
    }
  }

  /** The relay's own words: on the host, and on a room kept without it. */
  private relayText(text: string, socket: SocketLike, heard: boolean): void {
    const was = this.status
    if (text === HOST_AWAY) {
      if (was === 'connected') this.setStatus('waiting')
    } else if (text === HOST_BACK) {
      if (was === 'kept' || was === 'log-full') {
        // Live again: the host reconciles by sync, so what is held goes.
        this.kept.settle()
        this.greet(socket)
      } else if (was === 'waiting') this.setStatus('connected')
    } else if (text === LOG_FULL) {
      this.setStatus('log-full')
    } else {
      const until = parseNumbers('kept', text, 1)?.[0]
      if (until === undefined) return
      this.kept.active = true
      this.kept.until = until
      // The relay sends a peer that joins the snapshot and the log. One that
      // was live in the room has neither: it joins again to get them.
      if (heard) {
        socket.close(1000, 'joining again')
        return
      }
      this.setStatus('kept')
    }
  }

  /** The URL to connect to: with the last log entry held, which a header cannot say in a browser. */
  private socketUrl(): string {
    const after = this.kept.after
    if (after === undefined) return this.opts.url
    const url = new URL(this.opts.url)
    url.searchParams.set('after', String(after))
    return url.toString()
  }

  /** Sends an update of a doc as an entry, while the room is kept. Only editors do. */
  private sendEntry(id: number, update: Uint8Array): void {
    if (this.opts.keys.access !== 'edit') return
    const socket = this.socket
    this.sendChain = this.sendChain
      .then(async () => {
        const open = () => socket !== null && socket.readyState === OPEN
        const body = await this.kept.entry(id, update, open)
        if (body && socket) await this.putEntry(socket, body)
      })
      .catch((error) => this.opts.onError?.(error))
  }

  private async putEntry(socket: SocketLike, body: Uint8Array): Promise<void> {
    if (frameBytes(body.length) > MAX_FRAME_BYTES) {
      this.tooLarge(socket)
      return
    }
    await this.pace(this.pacer, body.length)
    if (socket.readyState === OPEN) socket.send(withKind(Kind.Entry, body))
  }

  /** Waits out the pacer's allowance for a message of this size. */
  private async pace(pacer: Pacer, bytes: number): Promise<void> {
    const wait = pacer.take(bytes)
    if (wait <= 0) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, wait)
      this.wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this.wake = null
  }

  /**
   * Sends the room this client's state, as a peer that just connected does:
   * to a host that returns to a room kept without it, the same.
   */
  private greet(socket: SocketLike): void {
    // The whole state goes to the room on connecting, from a peer that may
    // write it. When it does not fit a frame, send nothing: a SyncStep1
    // alone would have every peer answer with a state as large.
    const edits = this.edits()
    this.fresh.connected()
    if (edits && this.doc.store.clients.size > 0) this.fresh.wrote()
    const step2 = encoding.createEncoder()
    if (edits) syncProtocol.writeSyncStep2(step2, this.doc)
    const state = encoding.toUint8Array(step2)
    if (frameBytes(state.length) > MAX_FRAME_BYTES) {
      this.tooLarge(socket)
      return
    }
    // Before anyone hears this client is connected, and sends once. Signers
    // show they are live anew on every connection: what they sent while
    // this one was down could be sent again now.
    this.guard.forgetLive()
    this.settled = false
    this.settleIn(SETTLE_AFTER_MS)
    this.setStatus('connected')
    // First, so that peers answer it before what they send in reply.
    this.send(MessageType.Fresh, encodeFresh({ nonce: this.fresh.renew() }))
    this.sendSync((encoder) => syncProtocol.writeSyncStep1(encoder, this.doc))
    if (edits) this.send(MessageType.Sync, state)
    this.sendAwareness([this.doc.clientID])
    if (this.manifest) this.send(MessageType.Files, this.manifest)
    for (const [id, f] of this.files) this.syncFile(id, f.doc)
  }

  /** Announces departure, closes the socket and stops reconnecting. */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
    await this.sendChain
    this.destroyed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.manifestTimer) clearTimeout(this.manifestTimer)
    if (this.announceTimer) clearTimeout(this.announceTimer)
    if (this.resendTimer) clearTimeout(this.resendTimer)
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.held = []
    this.doc.off('update', this.handleDocUpdate)
    this.awareness.off('update', this.handleAwarenessUpdate)
    this.awareness.off('change', this.handleAwarenessChange)
    for (const f of this.files.values()) {
      f.doc.off('update', f.onUpdate)
      if (f.resyncTimer) clearTimeout(f.resyncTimer)
    }
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.setStatus('disconnected')
  }

  /**
   * Sends an attachment message to everyone else in the room. Like every other
   * frame, it is dropped while disconnected; retrying is up to the caller.
   */
  sendAttachment(attachment: Attachment): void {
    this.sendOnce(MessageType.Attachment, encodeAttachment(attachment))
  }

  /**
   * Sends a canvas message to everyone else in the room. Like every other
   * frame, it is dropped while disconnected.
   */
  sendCanvas(message: CanvasMessage): void {
    this.sendOnce(MessageType.Canvas, encodeCanvas(message))
  }

  /*
   * A room that shares several files keeps each in a Y.Doc of its own, synced
   * like `doc` but in files messages that name the file. `doc` is file 0, so
   * a peer that knows nothing of files goes on editing it, and the awareness
   * stays one for the room.
   */

  /**
   * Keeps `doc` in sync with the room as the file with this id, from 1 up
   * (file 0 is the client's own `doc`): sends its
   * state now if connected, and on every connection after. Messages about a
   * file that was not added are dropped, so a peer follows only the files it
   * added. With `check`, an update anyone sends for the file is applied only
   * if it passes: one that does not is dropped and reported to onError (see
   * Refusal for one refused for now). With `comments`, the doc holds a
   * file's comments, which commenters write as well as editors.
   */
  addFile(id: number, doc: Y.Doc, check?: UpdateCheck, opts: { comments?: boolean } = {}): void {
    if (!Number.isInteger(id) || id < 1 || id > MAX_FILE_ID)
      throw new Error(`invalid file id ${id}`)
    if (this.destroyed) throw new Error('client destroyed')
    if (this.files.has(id)) throw new Error(`file ${id} added twice`)
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this || !this.writes(id)) return
      if (this.kept.active) return this.sendEntry(id, update)
      this.fresh.wrote()
      this.sendFileSync(id, (encoder) => syncProtocol.writeUpdate(encoder, update))
    }
    doc.on('update', onUpdate)
    const comments = opts.comments ?? false
    this.files.set(id, {
      doc,
      check,
      comments,
      onUpdate,
      synced: false,
      resyncAt: 0,
      resyncTimer: null,
    })
    this.kept.adopt(id, doc, comments)
    const open = ['connected', 'waiting', 'kept'].includes(this.status)
    if (this.socket?.readyState === OPEN && open) this.syncFile(id, doc)
  }

  /**
   * Stops following a file added with addFile: its doc keeps what it has,
   * nothing more is sent or applied for it, and its id can be added again,
   * for another doc. Does nothing for a file not added.
   */
  removeFile(id: number): void {
    const f = this.files.get(id)
    if (!f) return
    f.doc.off('update', f.onUpdate)
    if (f.resyncTimer) clearTimeout(f.resyncTimer)
    this.files.delete(id)
  }

  /** Tells the room which files it shares, now and to everyone who connects later. */
  setManifest(files: FileEntry[]): void {
    this.manifest = encodeManifest(files)
    this.send(MessageType.Files, this.manifest)
  }

  /** Sends an attachment message about one file. Dropped while disconnected. */
  sendFileAttachment(file: number, attachment: Attachment): void {
    this.sendOnce(
      MessageType.Files,
      encodeFileDoc(file, MessageType.Attachment, encodeAttachment(attachment)),
    )
  }

  /** Sends a canvas message about one file. Dropped while disconnected. */
  sendFileCanvas(file: number, message: CanvasMessage): void {
    this.sendOnce(MessageType.Files, encodeFileDoc(file, MessageType.Canvas, encodeCanvas(message)))
  }

  private async receive(data: Uint8Array): Promise<void> {
    const frame = await this.readFrame(data)
    if (!frame) return
    const { access, message, vouched } = frame
    // An editor live in a room we hold edits for: the host is here, and takes them.
    if (vouched && access === 'edit' && !this.kept.active && this.kept.held > 0) this.kept.settle()
    if (message.type === MessageType.Fresh) {
      this.receiveFresh(frame, decodeFresh(message.payload))
      return
    }
    if (vouched) {
      this.dispatch(access, message)
      return
    }
    // Meanwhile what it sends counts as a reader's: requests only, which
    // change nothing when sent again. Its state comes once it is live.
    if (message.type === MessageType.Awareness) return
    try {
      this.dispatch('read', message)
    } catch (error) {
      if (!(error instanceof NotAllowedError)) throw error
    }
  }

  /** Applies a message as far as the access it speaks for allows. */
  private dispatch(access: Access, message: Message): void {
    const { payload } = message
    switch (message.type) {
      case MessageType.Sync: {
        allowSync(payload, access === 'edit', access)
        const { kind, reply } = readSync(payload, this.doc, this)
        if (reply && this.edits()) this.send(MessageType.Sync, reply)
        if (kind === syncProtocol.messageYjsSyncStep1) this.offerManifest()
        break
      }
      case MessageType.Awareness:
        this.receiveAwareness(access, payload)
        break
      case MessageType.Files:
        this.receiveFiles(access, payload)
        break
      case MessageType.Canvas: {
        editorsOnly('a canvas message', access)
        const canvas = decodeKnown(decodeCanvas, payload, UnknownCanvasKindError)
        if (canvas) this.opts.onCanvas?.(canvas)
        break
      }
      default: {
        const attachment = readAttachment(payload, access)
        if (attachment) this.opts.onAttachment?.(attachment)
      }
    }
  }

  /**
   * What access the peer with this awareness client ID has, from the frames
   * its state came in, if this client heard of it. This client's own ID has
   * its link's.
   */
  accessOf(clientId: number): Access | undefined {
    return clientId === this.doc.clientID ? this.opts.keys.access : this.presence.of(clientId)
  }

  /** Applies a peer's state by the rules in presence.ts. */
  private receiveAwareness(access: Access, payload: Uint8Array): void {
    const entry = decodeAwarenessEntry(decoding.readVarUint8Array(decoding.createDecoder(payload)))
    if (entry.id === this.doc.clientID) throw new NotAllowedError('a state of this client', access)
    if (access === 'read' && entry.clock > MAX_WIRE_CLOCK) {
      throw new NotAllowedError('an awareness clock out of range', access)
    }
    const before = this.presence.of(entry.id)
    const active = this.awareness.getStates().has(entry.id)
    if (!this.presence.admit(entry.id, access, active, () => this.unsignedStates())) {
      throw new NotAllowedError('awareness of a client heard from above', access)
    }
    if (access !== 'read') entry.clock = (this.awareness.meta.get(entry.id)?.clock ?? 0) + 1
    awarenessProtocol.applyAwarenessUpdate(this.awareness, encodeAwarenessEntry(entry), this)
    if (!this.awareness.getStates().has(entry.id)) this.presence.forget(entry.id)
    if (before && before !== access) this.opts.onAccess?.(entry.id)
  }

  /** The clients that sign nothing whose states this client holds now. */
  private unsignedStates(): number {
    let n = 0
    for (const id of this.awareness.getStates().keys()) if (this.presence.of(id) === 'read') n++
    return n
  }

  /**
   * Decrypts a frame, checks its signature, takes it once, and decodes its
   * message with the access it speaks for; null for an unknown type.
   */
  private async readFrame(data: Uint8Array): Promise<ReadFrame | null> {
    const plaintext = await decrypt(this.opts.keys.frameKey, data)
    const frame = decodeFrame(plaintext)
    if (!this.guard.foreign(frame.sender)) throw new ReplayedFrameError()
    const opened = await openMessage(
      this.opts.keys,
      plaintext.subarray(0, HEADER_BYTES),
      frame.message,
    )
    const { access } = opened
    // A signer that has not shown it is live yet (fresh.ts) may be one the
    // relay kept from before: its counters prove nothing yet.
    const vouched = access === 'read' || this.guard.known(access, frame.sender)
    if (vouched && access !== 'read' && !this.guard.accept(access, frame.sender, frame.counter))
      throw new ReplayedFrameError()
    // A newer peer may send message types we do not know yet; a signed
    // message inside another is one of those.
    const message = decodeKnown(decodeMessage, opened.message, UnknownMessageTypeError)
    return message && { access, message, vouched, sender: frame.sender, counter: frame.counter }
  }

  /**
   * Takes a fresh message: an answer to this client's nonce shows its signer
   * is live, and a nonce not answered yet gets an answer.
   */
  private receiveFresh(frame: ReadFrame, m: FreshMessage): void {
    const answersMe = this.fresh.answersMe(m.answer)
    if (answersMe && frame.access !== 'read' && !frame.vouched) {
      this.guard.vouch(frame.access, frame.sender, frame.counter)
    }
    if (!this.fresh.toAnswer(m.nonce)) return
    const state = this.fresh.hasToResend(answersMe)
    this.send(MessageType.Fresh, encodeFresh({ nonce: this.fresh.nonce, answer: m.nonce }))
    this.resend(state)
    this.settleIn(RESEND_EVERY_MS)
  }

  /**
   * Sends what is sent once rather than as state: held until this client
   * settles, for a client that signs (fresh.ts).
   */
  private sendOnce(type: MessageType, payload: Uint8Array): void {
    if (!this.settled && this.opts.keys.signer) {
      this.held.push({ type, payload })
      return
    }
    this.send(type, payload)
  }

  /** Has this client settle after `ms`, unless something puts it off. */
  private settleIn(ms: number): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.settled = true
      const held = this.held
      this.held = []
      for (const m of held) this.send(m.type, m.payload)
    }, ms)
  }

  /**
   * Sends again, at most every RESEND_EVERY_MS, what a peer that did not
   * know yet that this client is live dropped: its awareness, and with
   * `state` the doc's state and that of each file this client writes.
   */
  private resend(state: boolean): void {
    if (this.destroyed) return
    this.resendState ||= state
    const wait = this.resentAt + RESEND_EVERY_MS - performance.now()
    if (wait > 0) {
      this.resendTimer ??= setTimeout(() => {
        this.resendTimer = null
        this.resend(false)
      }, wait)
      return
    }
    this.resentAt = performance.now()
    this.sendAwareness([this.doc.clientID])
    if (!this.resendState) return
    this.resendState = false
    if (this.edits()) {
      const step2 = encoding.createEncoder()
      syncProtocol.writeSyncStep2(step2, this.doc)
      const state = encoding.toUint8Array(step2)
      if (frameBytes(state.length) <= MAX_FRAME_BYTES) this.send(MessageType.Sync, state)
    }
    for (const [id, f] of this.files) {
      if (!this.writes(id)) continue
      const step2 = encoding.createEncoder()
      syncProtocol.writeSyncStep2(step2, f.doc)
      const state = encodeFileDoc(id, MessageType.Sync, encoding.toUint8Array(step2))
      if (frameBytes(state.length) <= MAX_FRAME_BYTES) this.send(MessageType.Files, state)
    }
  }

  /**
   * The nonce of this client's connection, which a peer's answer carries
   * (fresh.ts). Not a secret.
   */
  get nonce(): Uint8Array {
    return this.fresh.nonce
  }

  private receiveFiles(access: Access, payload: Uint8Array): void {
    // As in readFrame, for files kinds and message types about a file.
    const m = decodeKnown(decodeFiles, payload, UnknownFilesKindError, UnknownMessageTypeError)
    if (!m) return
    if (m.kind === 'manifest') {
      editorsOnly('a manifest', access)
      this.opts.onManifest?.(m.files)
      return
    }
    switch (m.type) {
      case MessageType.Sync:
        this.receiveFileSync(m.file, access, m.payload)
        break
      case MessageType.Canvas: {
        editorsOnly('a canvas message', access)
        const canvas = decodeKnown(decodeCanvas, m.payload, UnknownCanvasKindError)
        if (canvas) this.opts.onFileCanvas?.(m.file, canvas)
        break
      }
      default: {
        const attachment = readAttachment(m.payload, access)
        if (attachment) this.opts.onFileAttachment?.(m.file, attachment)
      }
    }
  }

  private receiveFileSync(id: number, access: Access, payload: Uint8Array): void {
    const f = this.files.get(id)
    if (!f) return
    allowSync(payload, mayWrite(access, f.comments), access)
    const read = f.check
      ? checkedSync(payload, f.doc, f.check, this.checks, this)
      : readSync(payload, f.doc, this)
    if ('reason' in read) {
      this.opts.onError?.(new Error(`file ${id}: dropped an update: ${read.reason}`))
      if (read.retryLater) this.askAgain(id, f)
      return
    }
    const { kind, reply } = read
    if (reply && this.writes(id)) this.sendFile(id, MessageType.Sync, reply)
    if (kind === syncProtocol.messageYjsSyncStep2 && !f.synced) {
      f.synced = true
      this.opts.onFileSynced?.(id)
    }
  }

  /**
   * Asks the room for what a check refused for now: at once, or once
   * RESYNC_EVERY_MS has passed since it last asked, so that an update refused
   * while it waited is not left out. As internal/protocol does.
   */
  private askAgain(id: number, f: FileDoc): void {
    const ask = () => {
      f.resyncTimer = null
      f.resyncAt = performance.now() + RESYNC_EVERY_MS
      this.sendFileSync(id, (encoder) => syncProtocol.writeSyncStep1(encoder, f.doc))
    }
    const wait = f.resyncAt - performance.now()
    if (wait <= 0) ask()
    else f.resyncTimer ??= setTimeout(ask, wait)
  }

  /** Sends a file's state to the room, as onopen does for `doc`. */
  private syncFile(id: number, doc: Y.Doc): void {
    const socket = this.socket
    if (!socket) return
    this.sendFileSync(id, (encoder) => syncProtocol.writeSyncStep1(encoder, doc))
    if (!this.writes(id)) return
    const step2 = encoding.createEncoder()
    syncProtocol.writeSyncStep2(step2, doc)
    const state = encodeFileDoc(id, MessageType.Sync, encoding.toUint8Array(step2))
    if (frameBytes(state.length) > MAX_FRAME_BYTES) {
      this.tooLarge(socket)
      return
    }
    if (doc.store.clients.size > 0) this.fresh.wrote()
    this.send(MessageType.Files, state)
  }

  /**
   * Sends the manifest to someone who asked for file 0, at most every
   * MANIFEST_EVERY_MS: whoever asks meanwhile gets it once that has passed.
   */
  private offerManifest(): void {
    if (!this.manifest || this.destroyed) return
    const wait = this.manifestAt + MANIFEST_EVERY_MS - performance.now()
    if (wait > 0) {
      this.manifestTimer ??= setTimeout(() => {
        this.manifestTimer = null
        this.offerManifest()
      }, wait)
      return
    }
    this.manifestAt = performance.now()
    this.send(MessageType.Files, this.manifest)
  }

  private sendFileSync(id: number, write: (encoder: encoding.Encoder) => void): void {
    const encoder = encoding.createEncoder()
    write(encoder)
    this.sendFile(id, MessageType.Sync, encoding.toUint8Array(encoder))
  }

  private sendFile(id: number, type: MessageType, payload: Uint8Array): void {
    this.send(MessageType.Files, encodeFileDoc(id, type, payload))
  }

  /** Whether this client's link lets it edit the file, as only editors may. */
  private edits(): boolean {
    return this.opts.keys.access === 'edit'
  }

  /** Whether others apply what this client writes to the file with this id. */
  private writes(id: number): boolean {
    return mayWrite(this.opts.keys.access, this.files.get(id)?.comments ?? false)
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || !this.edits()) return
    if (this.kept.active) return this.sendEntry(0, update)
    this.fresh.wrote()
    this.sendSync((encoder) => syncProtocol.writeUpdate(encoder, update))
  }

  // Sends this client's own state when it changes. Others' states, and their
  // timing out, are each peer's own to follow.
  private handleAwarenessUpdate = (
    { added, updated, removed }: AwarenessChanges,
    origin: unknown,
  ) => {
    if (origin === this) return
    const self = this.doc.clientID
    if ([...added, ...updated, ...removed].includes(self)) this.sendAwareness([self])
  }

  // Someone new showed up: tell them about us soon instead of waiting for the
  // periodic awareness renewal, and which files the room shares.
  private handleAwarenessChange = ({ added, removed }: AwarenessChanges, origin: unknown) => {
    // Peers that time out go too.
    for (const id of removed) this.presence.forget(id)
    if (origin === this && added.length > 0) this.announce()
  }

  /**
   * Sends this client's state, at most every ANNOUNCE_EVERY_MS: newcomers
   * that show up meanwhile get it once that has passed. The manifest goes
   * with it, as offerManifest allows.
   */
  private announce(): void {
    if (this.destroyed) return
    const wait = this.announcedAt + ANNOUNCE_EVERY_MS - performance.now()
    if (wait > 0) {
      this.announceTimer ??= setTimeout(() => {
        this.announceTimer = null
        this.announce()
      }, wait)
      return
    }
    this.announcedAt = performance.now()
    this.sendAwareness([this.doc.clientID])
    this.offerManifest()
  }

  private dropRemoteAwareness(): void {
    const remote = [...this.awareness.getStates().keys()].filter((id) => id !== this.doc.clientID)
    awarenessProtocol.removeAwarenessStates(this.awareness, remote, this)
  }

  private sendSync(write: (encoder: encoding.Encoder) => void): void {
    const encoder = encoding.createEncoder()
    write(encoder)
    this.send(MessageType.Sync, encoding.toUint8Array(encoder))
  }

  private sendAwareness(clients: number[]): void {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients),
    )
    this.send(MessageType.Awareness, encoding.toUint8Array(encoder))
  }

  // Encryption is async; chain sends so frames leave in the order they were produced.
  private send(type: MessageType, payload: Uint8Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return
    if (frameBytes(payload.length) > MAX_FRAME_BYTES) {
      // The relay would close us with MESSAGE_TOO_BIG, and the same frame
      // would go again on every reconnect: leave for good instead.
      this.tooLarge(socket)
      return
    }
    // Numbered now, in the order frames are produced, which the chain keeps.
    const counter = ++this.sent
    const message = encodeMessage(type, payload)
    const signer = this.opts.keys.signer
    const pacer = this.pacer
    this.sendChain = this.sendChain
      .then(async () => {
        // A closed connection's frames are dropped, as frames sent while
        // disconnected are: the next handshake carries what they did.
        if (socket.readyState !== OPEN) return
        // Paced on leaving too: going over the allowance would close the
        // socket before the edits still queued reach the room.
        await this.pace(pacer, frameBytes(payload.length))
        const header = encodeFrame(this.sender, counter, new Uint8Array())
        const signed = signer ? await signMessage(signer, header, message) : message
        const data = await encrypt(
          this.opts.keys.frameKey,
          encodeFrame(this.sender, counter, signed),
        )
        if (socket.readyState === OPEN) socket.send(withKind(Kind.Live, data))
      })
      .catch((error) => this.opts.onError?.(error))
  }

  /** Leaves the room for good: a frame we had to send does not fit. */
  private tooLarge(socket: SocketLike): void {
    if (this.socket !== socket) return
    this.socket = null // onclose then ignores this socket: no reconnect
    this.wake?.()
    socket.close()
    // Told once the change that caused it is done: this runs inside Yjs
    // transactions and editor updates, which must not be re-entered.
    queueMicrotask(() => {
      if (this.destroyed) return
      this.dropRemoteAwareness()
      this.setStatus('too-large')
    })
  }

  private scheduleReconnect(atLeastMs = 0): void {
    if (this.destroyed) return
    const min = this.opts.minBackoffMs ?? 500
    const max = this.opts.maxBackoffMs ?? 30_000
    const backoff = Math.max(atLeastMs, Math.min(max, min * 2 ** this.attempts))
    const delay = backoff * (0.5 + Math.random() / 2)
    this.attempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setStatus(status: RoomStatus): void {
    if (this.status === status) return
    this.status = status
    this.opts.onStatus?.(status)
  }
}

/** A frame read: the access it speaks for, whether its signer showed it is live, and where it came from. */
interface ReadFrame {
  access: Access
  message: Message
  vouched: boolean
  sender: Uint8Array
  counter: bigint
}

interface AwarenessChanges {
  added: number[]
  updated: number[]
  removed: number[]
}

/**
 * Decodes a payload, or returns null when it throws one of `unknown`: a kind
 * this version does not know yet, from a newer peer, which is skipped.
 */
function decodeKnown<T>(
  decode: (payload: Uint8Array) => T,
  payload: Uint8Array,
  ...unknown: (abstract new (
    ...args: never[]
  ) => Error)[]
): T | null {
  try {
    return decode(payload)
  } catch (error) {
    if (unknown.some((type) => error instanceof type)) return null
    throw error
  }
}

/** Whether a peer with this access writes a doc that commenters write if `comments`. */
const mayWrite = (access: Access, comments: boolean) =>
  access === 'edit' || (access === 'comment' && comments)

/**
 * Lets a sync message through only if it is a request for what the sender
 * is missing (SyncStep1), unless the sender may write the doc: anyone in the
 * room needs to receive the doc, but only its writers change it.
 */
function allowSync(payload: Uint8Array, writes: boolean, access: Access): void {
  if (writes) return
  let kind: number
  try {
    kind = decoding.readVarUint(decoding.createDecoder(payload))
  } catch {
    throw new NotAllowedError('a sync message', access)
  }
  if (kind !== syncProtocol.messageYjsSyncStep1) throw new NotAllowedError('an update', access)
}

/** Refuses a message that only editors may send, from anyone else. */
function editorsOnly(what: string, access: Access): void {
  if (access !== 'edit') throw new NotAllowedError(what, access)
}

/**
 * Decodes an attachment message, of a kind only editors send unless it asks
 * for attachments (`want`), which everyone needs to see the images.
 */
function readAttachment(payload: Uint8Array, access: Access): Attachment | null {
  const attachment = decodeKnown(decodeAttachment, payload, UnknownAttachmentKindError)
  if (attachment && attachment.kind !== 'want')
    editorsOnly(`an attachment ${attachment.kind}`, access)
  return attachment
}

/**
 * Applies a sync message to a checked file's `doc`, as readSync does, if
 * `check` passes the update it carries; or tells why not. Checking and
 * applying count against `share`, the time of all checked files: past it,
 * an update is refused for now.
 */
function checkedSync(
  payload: Uint8Array,
  doc: Y.Doc,
  check: UpdateCheck,
  share: TimeShare,
  origin: unknown,
): Refusal | { kind: number; reply: Uint8Array | null } {
  let update: Uint8Array
  try {
    const decoder = decoding.createDecoder(payload)
    const kind = decoding.readVarUint(decoder)
    if (kind !== syncProtocol.messageYjsSyncStep2 && kind !== syncProtocol.messageYjsUpdate) {
      return readSync(payload, doc, origin)
    }
    update = decoding.readVarUint8Array(decoder)
  } catch {
    return { reason: 'not a sync message' }
  }
  const now = performance.now()
  share.credit = Math.min(CHECK_BURST_MS, share.credit + (now - share.counted) / CHECK_SHARE)
  share.counted = now
  if (share.credit <= 0) return { reason: 'checking updates took too long', retryLater: true }
  try {
    let refused: Refusal | null
    try {
      refused = check(doc, update)
    } catch {
      refused = { reason: 'the check failed' }
    }
    return refused ?? readSync(payload, doc, origin)
  } finally {
    const end = performance.now()
    share.credit -= end - now
    share.counted = end
  }
}

/** Applies a sync message to `doc`, with the reply it calls for, if any. */
function readSync(
  payload: Uint8Array,
  doc: Y.Doc,
  origin: unknown,
): { kind: number; reply: Uint8Array | null } {
  const encoder = encoding.createEncoder()
  const kind = syncProtocol.readSyncMessage(decoding.createDecoder(payload), encoder, doc, origin)
  return { kind, reply: encoding.length(encoder) > 0 ? encoding.toUint8Array(encoder) : null }
}

// Node.js (undici) accepts `{ headers }` as the second argument; browsers take
// subprotocols there, so only pass it when headers are given.
function defaultCreateSocket(
  url: string,
  headers?: Record<string, string>,
  protocols?: string[],
): SocketLike {
  const WS = WebSocket as unknown as new (url: string, init?: unknown) => SocketLike
  return headers ? new WS(url, { headers, protocols }) : new WS(url, protocols)
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return null
}
