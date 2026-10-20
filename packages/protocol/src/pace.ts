import { MAX_FRAME_BYTES } from './frame.ts'

/** A burst, then a steady rate. */
export interface Rate {
  burst: number
  perSecond: number
}

/**
 * What one connection may send to the relay: messages, and their bytes on
 * the wire. The relay (packages/worker) closes a connection over either with
 * RATE_LIMITED, and a host closed so ends the room. Bytes allow every peer
 * of a full room (32) to send a whole document at once. Keep equal to
 * RelayMessages and RelayBytes in internal/protocol.
 */
export const RELAY_MESSAGE_RATE: Rate = { burst: 1000, perSecond: 200 }
export const RELAY_BYTE_RATE: Rate = { burst: 32 * MAX_FRAME_BYTES, perSecond: 1024 * 1024 }

/** RoomClient keeps to this share of the relay's rates, for clock drift. */
const MARGIN = 7 / 8

/**
 * Paces what a client sends so it stays within the relay's rates: a room
 * that shares several files sends each file's state on connecting, and can
 * outrun the relay's allowance where one file never does. Editing stays far
 * below it and is never held back.
 */
export class Pacer {
  private readonly messages: Rate
  private readonly bytes: Rate
  private messageTokens: number
  private byteTokens: number
  private at: number
  // Not a parameter property: Node.js strips types but cannot run those.
  private readonly now: () => number

  constructor(
    messages: Rate = RELAY_MESSAGE_RATE,
    bytes: Rate = RELAY_BYTE_RATE,
    now: () => number = () => performance.now(),
  ) {
    this.now = now
    this.messages = { burst: messages.burst * MARGIN, perSecond: messages.perSecond * MARGIN }
    this.bytes = { burst: bytes.burst * MARGIN, perSecond: bytes.perSecond * MARGIN }
    this.messageTokens = this.messages.burst
    this.byteTokens = this.bytes.burst
    this.at = this.now()
  }

  /**
   * Takes one message of `bytes` from the allowance, and returns how many
   * milliseconds to wait before sending it: 0 within the allowance. Messages
   * are taken in the order they are to be sent.
   */
  take(bytes: number): number {
    const now = this.now()
    const seconds = Math.max(0, now - this.at) / 1000
    this.at = now
    this.messageTokens = Math.min(
      this.messages.burst,
      this.messageTokens + seconds * this.messages.perSecond,
    )
    this.byteTokens = Math.min(this.bytes.burst, this.byteTokens + seconds * this.bytes.perSecond)
    this.messageTokens -= 1
    this.byteTokens -= bytes
    const wait = Math.max(
      -this.messageTokens / this.messages.perSecond,
      -this.byteTokens / this.bytes.perSecond,
    )
    return wait > 0 ? wait * 1000 : 0
  }
}
