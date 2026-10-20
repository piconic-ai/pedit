import { MESSAGE_TOO_BIG, RELAY_BUSY, ROOM_CLOSED, ROOM_FULL } from './close.ts'
import type { Rate } from './pace.ts'
import type { SocketLike } from './room.ts'

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
    if (this.relay.opts.maxFrame !== undefined && data.length > this.relay.opts.maxFrame) {
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
