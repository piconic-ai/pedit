import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import type * as Y from 'yjs'
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
  MAX_FRAME_BYTES,
  ReplayedFrameError,
  ReplayGuard,
  SENDER_BYTES,
} from './frame.ts'
import {
  decodeMessage,
  encodeMessage,
  type Message,
  MessageType,
  UnknownMessageTypeError,
} from './message.ts'
import { Pacer, type Rate } from './pace.ts'

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
 */
export type RoomStatus =
  | 'connecting'
  | 'connected'
  | 'waiting'
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
  key: CryptoKey
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
  onError?: (error: unknown) => void
  onAttachment?: (attachment: Attachment) => void
  onCanvas?: (message: CanvasMessage) => void
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
 * Checking and applying the updates of all checked files together may take
 * a quarter of the time, with up to a second in hand, so a peer flooding the
 * room cannot keep the client checking; an update past that is refused for
 * now. As internal/protocol does.
 */
const CHECK_SHARE = 4
const CHECK_BURST_MS = 1000
const RESYNC_EVERY_MS = 5000

const OPEN = 1

/**
 * Keeps a Y.Doc and Awareness in sync with every other peer in a room.
 *
 * The server is a dumb relay, so the peers run a symmetric protocol: on connect a
 * peer sends SyncStep1 (to pull what it is missing), its full state as an update
 * (to push what others are missing) and its awareness state. Every peer answers
 * SyncStep1 with SyncStep2. All frames are end-to-end encrypted.
 */
export class RoomClient {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  status: RoomStatus = 'disconnected'
  /** The relay's time limit in seconds, when it said so on closing an expired room. */
  timeLimitSeconds: number | undefined

  private readonly opts: RoomClientOptions
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
  private readonly files = new Map<number, FileDoc>()
  /** The time checked files' updates may take, as CHECK_SHARE says. */
  private readonly checks: TimeShare = { credit: CHECK_BURST_MS, counted: performance.now() }
  // Paces the frames sent on the current socket; see Pacer.
  private pacer = new Pacer()
  // Ends the pacing wait of the frame next in line, when its socket closes.
  private wake: (() => void) | null = null
  // The encoded manifest, when this client set one.
  private manifest: Uint8Array | null = null

  constructor(opts: RoomClientOptions) {
    this.opts = opts
    this.doc = opts.doc
    this.awareness = opts.awareness
    this.doc.on('update', this.handleDocUpdate)
    this.awareness.on('update', this.handleAwarenessUpdate)
    this.awareness.on('change', this.handleAwarenessChange)
  }

  connect(): void {
    if (this.destroyed || this.socket) return
    this.setStatus('connecting')
    const createSocket = this.opts.createSocket ?? defaultCreateSocket
    const socket = createSocket(
      this.opts.url,
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
      // The whole state goes to the room on connecting. When it does not fit a
      // frame, send nothing: a SyncStep1 alone would have every peer answer
      // with a state as large.
      const step2 = encoding.createEncoder()
      syncProtocol.writeSyncStep2(step2, this.doc)
      const state = encoding.toUint8Array(step2)
      if (frameBytes(state.length) > MAX_FRAME_BYTES) {
        this.tooLarge(socket)
        return
      }
      this.setStatus('connected')
      this.sendSync((encoder) => syncProtocol.writeSyncStep1(encoder, this.doc))
      this.send(MessageType.Sync, state)
      this.sendAwareness([this.doc.clientID])
      if (this.manifest) this.send(MessageType.Files, this.manifest)
      for (const [id, f] of this.files) this.syncFile(id, f.doc)
    }
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return
      // The relay's own word on the host, the only text it sends.
      if (ev.data === HOST_AWAY) {
        if (this.status === 'connected') this.setStatus('waiting')
        return
      }
      if (ev.data === HOST_BACK) {
        if (this.status === 'waiting') this.setStatus('connected')
        return
      }
      const data = toBytes(ev.data)
      if (!data) return
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

  /** Announces departure, closes the socket and stops reconnecting. */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
    await this.sendChain
    this.destroyed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
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
    this.send(MessageType.Attachment, encodeAttachment(attachment))
  }

  /**
   * Sends a canvas message to everyone else in the room. Like every other
   * frame, it is dropped while disconnected.
   */
  sendCanvas(message: CanvasMessage): void {
    this.send(MessageType.Canvas, encodeCanvas(message))
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
   * Refusal for one refused for now).
   */
  addFile(id: number, doc: Y.Doc, check?: UpdateCheck): void {
    if (!Number.isInteger(id) || id < 1 || id > MAX_FILE_ID)
      throw new Error(`invalid file id ${id}`)
    if (this.destroyed) throw new Error('client destroyed')
    if (this.files.has(id)) throw new Error(`file ${id} added twice`)
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this) return
      this.sendFileSync(id, (encoder) => syncProtocol.writeUpdate(encoder, update))
    }
    doc.on('update', onUpdate)
    this.files.set(id, { doc, check, onUpdate, synced: false, resyncAt: 0, resyncTimer: null })
    const open = this.status === 'connected' || this.status === 'waiting'
    if (this.socket?.readyState === OPEN && open) this.syncFile(id, doc)
  }

  /** Tells the room which files it shares, now and to everyone who connects later. */
  setManifest(files: FileEntry[]): void {
    this.manifest = encodeManifest(files)
    this.send(MessageType.Files, this.manifest)
  }

  /** Sends an attachment message about one file. Dropped while disconnected. */
  sendFileAttachment(file: number, attachment: Attachment): void {
    this.sendFile(file, MessageType.Attachment, encodeAttachment(attachment))
  }

  /** Sends a canvas message about one file. Dropped while disconnected. */
  sendFileCanvas(file: number, message: CanvasMessage): void {
    this.sendFile(file, MessageType.Canvas, encodeCanvas(message))
  }

  private async receive(data: Uint8Array): Promise<void> {
    const message = await this.readFrame(data)
    if (!message) return
    const { payload } = message
    switch (message.type) {
      case MessageType.Sync: {
        const reply = readSync(payload, this.doc, this).reply
        if (reply) this.send(MessageType.Sync, reply)
        break
      }
      case MessageType.Awareness:
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoding.createDecoder(payload)),
          this,
        )
        break
      case MessageType.Files:
        this.receiveFiles(payload)
        break
      case MessageType.Canvas: {
        const canvas = decodeKnown(decodeCanvas, payload, UnknownCanvasKindError)
        if (canvas) this.opts.onCanvas?.(canvas)
        break
      }
      default: {
        const attachment = decodeKnown(decodeAttachment, payload, UnknownAttachmentKindError)
        if (attachment) this.opts.onAttachment?.(attachment)
      }
    }
  }

  /** Decrypts a frame, taking it once, and decodes its message; null for an unknown type. */
  private async readFrame(data: Uint8Array): Promise<Message | null> {
    const frame = decodeFrame(await decrypt(this.opts.key, data))
    if (!this.guard.accept(frame.sender, frame.counter)) throw new ReplayedFrameError()
    // A newer peer may send message types we do not know yet.
    return decodeKnown(decodeMessage, frame.message, UnknownMessageTypeError)
  }

  private receiveFiles(payload: Uint8Array): void {
    // As in readFrame, for files kinds and message types about a file.
    const m = decodeKnown(decodeFiles, payload, UnknownFilesKindError, UnknownMessageTypeError)
    if (!m) return
    if (m.kind === 'manifest') {
      this.opts.onManifest?.(m.files)
      return
    }
    switch (m.type) {
      case MessageType.Sync:
        this.receiveFileSync(m.file, m.payload)
        break
      case MessageType.Canvas: {
        const canvas = decodeKnown(decodeCanvas, m.payload, UnknownCanvasKindError)
        if (canvas) this.opts.onFileCanvas?.(m.file, canvas)
        break
      }
      default: {
        const attachment = decodeKnown(decodeAttachment, m.payload, UnknownAttachmentKindError)
        if (attachment) this.opts.onFileAttachment?.(m.file, attachment)
      }
    }
  }

  private receiveFileSync(id: number, payload: Uint8Array): void {
    const f = this.files.get(id)
    if (!f) return
    const read = f.check
      ? checkedSync(payload, f.doc, f.check, this.checks, this)
      : readSync(payload, f.doc, this)
    if ('reason' in read) {
      this.opts.onError?.(new Error(`file ${id}: dropped an update: ${read.reason}`))
      if (read.retryLater) this.askAgain(id, f)
      return
    }
    const { kind, reply } = read
    if (reply) this.sendFile(id, MessageType.Sync, reply)
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
    const step2 = encoding.createEncoder()
    syncProtocol.writeSyncStep2(step2, doc)
    const state = encodeFileDoc(id, MessageType.Sync, encoding.toUint8Array(step2))
    if (frameBytes(state.length) > MAX_FRAME_BYTES) {
      this.tooLarge(socket)
      return
    }
    this.sendFileSync(id, (encoder) => syncProtocol.writeSyncStep1(encoder, doc))
    this.send(MessageType.Files, state)
  }

  private sendFileSync(id: number, write: (encoder: encoding.Encoder) => void): void {
    const encoder = encoding.createEncoder()
    write(encoder)
    this.sendFile(id, MessageType.Sync, encoding.toUint8Array(encoder))
  }

  private sendFile(id: number, type: MessageType, payload: Uint8Array): void {
    this.send(MessageType.Files, encodeFileDoc(id, type, payload))
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return
    this.sendSync((encoder) => syncProtocol.writeUpdate(encoder, update))
  }

  private handleAwarenessUpdate = (
    { added, updated, removed }: AwarenessChanges,
    origin: unknown,
  ) => {
    if (origin === this) return
    this.sendAwareness([...added, ...updated, ...removed])
  }

  // Someone new showed up: tell them about us right away instead of waiting for the
  // periodic awareness renewal, and which files the room shares.
  private handleAwarenessChange = ({ added }: AwarenessChanges, origin: unknown) => {
    if (origin === this && added.length > 0) {
      this.sendAwareness([this.doc.clientID])
      if (this.manifest) this.send(MessageType.Files, this.manifest)
    }
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
    const plaintext = encodeFrame(this.sender, ++this.sent, encodeMessage(type, payload))
    const pacer = this.pacer
    this.sendChain = this.sendChain
      .then(async () => {
        // A closed connection's frames are dropped, as frames sent while
        // disconnected are: the next handshake carries what they did.
        if (socket.readyState !== OPEN) return
        // Paced on leaving too: going over the allowance would close the
        // socket before the edits still queued reach the room.
        const wait = pacer.take(frameBytes(payload.length))
        if (wait > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, wait)
            this.wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          this.wake = null
        }
        const data = await encrypt(this.opts.key, plaintext)
        if (socket.readyState === OPEN) socket.send(data)
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
