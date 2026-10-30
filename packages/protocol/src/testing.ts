import {
  type Access,
  deriveRoomKeys,
  generateEditSecret,
  parseFragment,
  type RoomKeys,
} from './access.ts'
import { encrypt } from './cipher.ts'
import { MESSAGE_TOO_BIG, RELAY_BUSY, ROOM_CLOSED, ROOM_FULL } from './close.ts'
import { encodeFrame } from './frame.ts'
import { encodeFresh, NONCE_BYTES } from './fresh.ts'
import { Kind, withKind } from './kinds.ts'
import { encodeMessage, MessageType } from './message.ts'
import type { Rate } from './pace.ts'
import type { RoomClient, SocketLike } from './room.ts'
import { signMessage } from './signed.ts'

/** The room id tests derive keys for. */
export const TEST_ROOM = 'test-room'

/** An editor's keys for a new room, or for the room of `secret`. */
export async function editKeys(secret = generateEditSecret()): Promise<RoomKeys> {
  return linkKeys(secret)
}

/** The keys of a room link's fragment, in TEST_ROOM. */
export async function linkKeys(fragment: string): Promise<RoomKeys> {
  const link = parseFragment(fragment)
  if (!link) throw new Error(`not a room link: ${fragment}`)
  return deriveRoomKeys(link, TEST_ROOM)
}

/** The keys of the link below `keys` with this access, in the same room. */
export function lowerKeys(keys: RoomKeys, access: Access): Promise<RoomKeys> {
  const fragment = keys.fragments[access]
  if (!fragment) throw new Error(`no ${access} link below ${keys.access}`)
  return linkKeys(fragment)
}

/**
 * A frame as a client with `keys` sends it: `message` (encodeMessage) from
 * `sender`, numbered `counter`, signed if the link signs, and encrypted.
 */
export async function sealFrame(
  keys: RoomKeys,
  sender: Uint8Array,
  counter: number,
  message: Uint8Array,
): Promise<Uint8Array> {
  const header = encodeFrame(sender, counter, new Uint8Array())
  const body = keys.signer ? await signMessage(keys.signer, header, message) : message
  return encrypt(keys.frameKey, encodeFrame(sender, counter, body))
}

/** A sealed frame as it travels in protocol version 6: a live message (kind 0). */
export async function wireFrame(
  keys: RoomKeys,
  sender: Uint8Array,
  counter: number,
  message: Uint8Array,
): Promise<Uint8Array> {
  return withKind(Kind.Live, await sealFrame(keys, sender, counter, message))
}

/**
 * A fresh message answering `client`'s nonce of its connection: `client`
 * takes the signed frames its sender sends after it (fresh.ts).
 */
export function answer(client: RoomClient): Uint8Array {
  return encodeMessage(
    MessageType.Fresh,
    encodeFresh({ nonce: new Uint8Array(NONCE_BYTES), answer: client.nonce }),
  )
}

/** The Room's close code for a connection over its rate (RATE_LIMITED in packages/worker). */
export const RATE_LIMITED = 1008

export interface RelayOptions {
  /**
   * Behave like the real Room: a socket that sent an Authorization header is the
   * host, guests are turned away while no host is connected, and everyone is
   * disconnected with ROOM_CLOSED when the last host leaves.
   */
  hosted?: boolean
  /** Guests at once, the host not counted; more are turned away with ROOM_FULL. */
  guests?: number
  /** Turn every socket away with this close code, as the Room does on a protocol version mismatch. */
  refuse?: number
  /** The close reason that goes with `refuse`. */
  refuseReason?: string
  /** Turn away this many sockets with RELAY_BUSY before letting any in. */
  busy?: number
  /** Close a socket that sends more bytes than this with RATE_LIMITED, as the Room does. */
  byteRate?: Rate
  /** Close a socket that sends a larger frame with MESSAGE_TOO_BIG, as the Room does at MAX_FRAME_BYTES. */
  maxFrame?: number
}

/** An in-memory stand-in for the Worker: relays every frame to all other sockets. */
export class Relay {
  sockets = new Set<FakeSocket>()
  frames: Uint8Array[] = []
  /** Sockets closed for going over `byteRate`. */
  rateLimited = 0
  urls: string[] = []
  headers: (Record<string, string> | undefined)[] = []
  protocols: (string[] | undefined)[] = []

  constructor(readonly opts: RelayOptions = {}) {}

  create = (url: string, headers?: Record<string, string>, protocols?: string[]): SocketLike => {
    this.urls.push(url)
    this.headers.push(headers)
    this.protocols.push(protocols)
    const socket = new FakeSocket(this, Boolean(headers?.Authorization))
    this.sockets.add(socket)
    queueMicrotask(() => {
      if (this.opts.busy) {
        this.opts.busy--
        socket.close(RELAY_BUSY)
        return
      }
      if (this.opts.refuse !== undefined) {
        socket.close(this.opts.refuse, this.opts.refuseReason)
        return
      }
      if (this.opts.hosted && !socket.isHost && !this.hasHost()) {
        socket.close(ROOM_CLOSED)
        return
      }
      const guests = [...this.sockets].filter((s) => !s.isHost && s.readyState === 1).length
      if (!socket.isHost && this.opts.guests !== undefined && guests >= this.opts.guests) {
        socket.close(ROOM_FULL)
        return
      }
      socket.readyState = 1
      socket.onopen?.({})
    })
    return socket
  }

  hasHost(except?: FakeSocket): boolean {
    return [...this.sockets].some((s) => s.isHost && s !== except && s.readyState !== 3)
  }

  /** Closes every socket with this code, as the Room does at its time limit. */
  closeAll(code: number, reason?: string): void {
    const sockets = [...this.sockets]
    // Gone first, so the host closing does not close the others with ROOM_CLOSED.
    this.sockets.clear()
    for (const socket of sockets) socket.close(code, reason)
  }

  /** Sends every guest a text frame of the relay's own, such as HOST_AWAY. */
  signal(text: string): void {
    for (const socket of this.sockets) {
      if (!socket.isHost && socket.readyState === 1) {
        queueMicrotask(() => socket.onmessage?.({ data: text }))
      }
    }
  }

  /** Called by a socket as it closes. */
  left(socket: FakeSocket): void {
    this.sockets.delete(socket)
    if (this.opts.hosted && socket.isHost && !this.hasHost()) {
      for (const peer of this.sockets) peer.close(ROOM_CLOSED)
    }
  }
}

export class FakeSocket implements SocketLike {
  binaryType = 'blob'
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  // The byte allowance under RelayOptions.byteRate, and when it was counted.
  private bytes: number | undefined
  private at: number | undefined
  constructor(
    private relay: Relay,
    readonly isHost: boolean,
  ) {}
  send(data: Uint8Array) {
    // The kind byte is not part of the frame.
    if (this.relay.opts.maxFrame !== undefined && data.length - 1 > this.relay.opts.maxFrame) {
      this.close(MESSAGE_TOO_BIG)
      return
    }
    const rate = this.relay.opts.byteRate
    if (rate) {
      const now = performance.now()
      const seconds = this.at === undefined ? 0 : (now - this.at) / 1000
      this.at = now
      this.bytes = Math.min(rate.burst, (this.bytes ?? rate.burst) + seconds * rate.perSecond)
      if (this.bytes < data.length) {
        this.relay.rateLimited++
        this.close(RATE_LIMITED)
        return
      }
      this.bytes -= data.length
    }
    this.relay.frames.push(data)
    for (const peer of this.relay.sockets) {
      if (peer !== this && peer.readyState === 1) {
        const copy = data.slice().buffer
        queueMicrotask(() => peer.onmessage?.({ data: copy }))
      }
    }
  }
  close(code?: number, reason?: string) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.relay.left(this)
    queueMicrotask(() => this.onclose?.({ code, reason }))
  }
}
