/*
 * Anyone with a read link decrypts every frame, so they could keep a signed
 * frame and have it sent again later. The replay guard (frame.ts) drops it
 * for peers that saw the sender's later frames, but a peer that has just
 * joined has seen none, and would take it as new. So a RoomClient takes
 * signed frames from a sender only once the sender showed it is live (#122):
 *
 * - On every connection the client picks a random nonce and sends it in a
 *   fresh message, before anything else.
 * - A client answers every nonce it has not answered yet with a fresh
 *   message of its own carrying the nonce, numbered after everything it sent
 *   before. A signer's answer shows it is live; any answer also carries the
 *   client's own nonce, so a peer that came later answers it in turn.
 * - Until a signer's answer to the client's own nonce of this connection
 *   arrives, the client takes that signer's frames as a reader's (requests
 *   only), and drops its awareness. The answer's counter then becomes the
 *   floor of the replay guard for the signer: what it sent before seeing the
 *   nonce is dropped, as anything kept from before would be. This holds on
 *   every connection, a reconnection too: what a signer sent while the
 *   client was away could be kept and sent again.
 * - A peer drops what the client sent until the client answers its nonce.
 *   So after each answer the client sends its awareness again. Its state, a
 *   peer asks for after the answer, unless the peer was in the room before
 *   the client (its answer carried the client's nonce) and the client sent
 *   content of its own since connecting, or the client sent content of its
 *   own shortly before the nonce reached it, which may have been after the
 *   peer connected: then the client sends its state again too. Both at most
 *   every RESEND_EVERY_MS. Only content of its own counts (edits, and a state
 *   with something in it pushed on connecting or adding a file): a state the
 *   peer has already still makes an update there.
 *
 * - What a client sends once rather than as state (attachments and canvas
 *   messages) is not sent again. So a client that signs holds it after
 *   connecting until it settles: a peer takes its frames from its answer
 *   on, so RESEND_EVERY_MS after the last answer it sent, or
 *   SETTLE_AFTER_MS if it sends none, alone in the room. Then it sends what
 *   it held, in order.
 *
 * Peers that stay connected answer each other once; a newcomer gets one
 * answer from each signer before their answers to its requests.
 *
 * Keep in sync with internal/protocol/fresh.go.
 */

export const NONCE_BYTES = 16
/** How many nonces a client remembers having answered. */
const MAX_ANSWERED = 1024
/**
 * Spaces out the state a client sends again after answering: long enough to
 * cover the answers of everyone in the room to its connecting, short enough
 * not to keep them waiting.
 */
export const RESEND_EVERY_MS = 250
/**
 * How long before a nonce reached a client the content it sent may have
 * reached the nonce's peer after it connected.
 */
export const STATE_WINDOW_MS = 5000
/**
 * How long a client that hears no answer after connecting holds what it
 * sends once: alone in the room, nobody drops it.
 */
export const SETTLE_AFTER_MS = 1000

/** A fresh message: the sender's nonce of its connection, and the nonce of the peer it answers, if any. */
export interface FreshMessage {
  nonce: Uint8Array
  answer?: Uint8Array
}

/** Encodes a fresh message's payload: the nonce, then the answer. */
export function encodeFresh(m: FreshMessage): Uint8Array {
  const out = new Uint8Array(NONCE_BYTES * (m.answer ? 2 : 1))
  out.set(m.nonce)
  if (m.answer) out.set(m.answer, NONCE_BYTES)
  return out
}

/** Reverses encodeFresh. */
export function decodeFresh(payload: Uint8Array): FreshMessage {
  if (payload.length === NONCE_BYTES) return { nonce: payload.slice() }
  if (payload.length === 2 * NONCE_BYTES) {
    return { nonce: payload.slice(0, NONCE_BYTES), answer: payload.slice(NONCE_BYTES) }
  }
  throw new Error('malformed fresh message')
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** A client's side of the handshake. */
export class Freshness {
  private current = new Uint8Array(NONCE_BYTES)
  private readonly answered = new Set<string>()
  private wroteAt = Number.NEGATIVE_INFINITY
  private wroteSince = false

  /** Picks the nonce of a new connection. */
  renew(): Uint8Array {
    this.current = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
    return this.current
  }

  /** The nonce of the client's connection. */
  get nonce(): Uint8Array {
    return this.current
  }

  /** Whether an answer carries the nonce of this connection. */
  answersMe(answer: Uint8Array | undefined): boolean {
    return answer !== undefined && hex(answer) === hex(this.current)
  }

  /** Whether `nonce` is yet to be answered, counting it answered. */
  toAnswer(nonce: Uint8Array): boolean {
    const key = hex(nonce)
    if (this.answered.has(key)) return false
    if (this.answered.size === MAX_ANSWERED) {
      const oldest = this.answered.values().next().value
      if (oldest !== undefined) this.answered.delete(oldest)
    }
    this.answered.add(key)
    return true
  }

  /** Notes that the client sent content of its own. */
  wrote(): void {
    this.wroteAt = performance.now()
    this.wroteSince = true
  }

  /** Starts counting what the client sends on a new connection. */
  connected(): void {
    this.wroteSince = false
  }

  /**
   * Whether the client sent content of its own a peer whose nonce it
   * answers may have dropped: lately, or since connecting if the peer was in
   * the room before it.
   */
  hasToResend(peerWasFirst: boolean): boolean {
    return performance.now() - this.wroteAt < STATE_WINDOW_MS || (peerWasFirst && this.wroteSince)
  }
}
