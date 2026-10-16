/**
 * The most bytes one frame may have on the wire: one WebSocket message,
 * encrypted. The relay closes a connection that sends a larger one with
 * MESSAGE_TOO_BIG, and RoomClient never sends one. Keep it equal to
 * MaxFrameBytes in internal/protocol.
 */
export const MAX_FRAME_BYTES = 1024 * 1024

/**
 * A frame encrypts `sender || counter || message`. The relay could otherwise
 * send a frame again, and a canvas edit applied twice is not the same as once
 * (Yjs updates and awareness are). Each client picks a random sender when it
 * starts and counts the frames it sends from 1, across reconnects; receivers
 * drop a frame whose counter is not above the last one from its sender. The
 * room key is new for every room and the host stays for its whole life, so
 * the host never applies a frame twice. Keep in sync with internal/protocol.
 */
export const SENDER_BYTES = 16
const HEADER_BYTES = SENDER_BYTES + 8

/**
 * What a frame adds to its payload: the sender and counter, the message type
 * byte, and AES-GCM's 12-byte IV and 16-byte tag.
 */
export const FRAME_OVERHEAD = HEADER_BYTES + 1 + 12 + 16

/** The size on the wire of a frame carrying `payload` bytes. */
export function frameBytes(payload: number): number {
  return payload + FRAME_OVERHEAD
}

/** A frame received before, or one of our own: only the relay can send those. */
export class ReplayedFrameError extends Error {
  constructor() {
    super('frame received twice')
    this.name = 'ReplayedFrameError'
  }
}

/** Puts the sender and its counter before a message (encodeMessage): what a frame encrypts. */
export function encodeFrame(sender: Uint8Array, counter: number, message: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + message.length)
  out.set(sender, 0)
  new DataView(out.buffer).setBigUint64(SENDER_BYTES, BigInt(counter))
  out.set(message, HEADER_BYTES)
  return out
}

/** Reverses encodeFrame. */
export function decodeFrame(data: Uint8Array): {
  sender: Uint8Array
  counter: bigint
  message: Uint8Array
} {
  if (data.length < HEADER_BYTES) throw new Error('frame too short')
  return {
    sender: data.subarray(0, SENDER_BYTES),
    counter: new DataView(data.buffer, data.byteOffset).getBigUint64(SENDER_BYTES),
    message: data.subarray(HEADER_BYTES),
  }
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Remembers the last counter from each sender. Only peers with the key can
 * add senders, so it grows with the people who joined the room.
 */
export class ReplayGuard {
  private readonly self: string
  private readonly last = new Map<string, bigint>()

  constructor(self: Uint8Array) {
    this.self = hex(self)
  }

  /** Whether a frame is new, remembering it when it is. */
  accept(sender: Uint8Array, counter: bigint): boolean {
    const id = hex(sender)
    if (id === this.self || counter <= (this.last.get(id) ?? 0n)) return false
    this.last.set(id, counter)
    return true
  }
}
