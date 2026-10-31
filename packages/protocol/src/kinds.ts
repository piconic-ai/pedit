/**
 * Protocol version 6 starts every binary WebSocket message with one plaintext
 * byte, the kind. The relay reads only this byte; the payload after it is as
 * it was in version 5 (docs/design/rooms-away.md).
 */
export const Kind = {
  /** A frame (frame.ts), any peer to the relay and on to every other peer. */
  Live: 0,
  /** One kept-text entry, an editor to the relay. */
  Entry: 1,
  /** A kept bundle, the host to the relay: the room's snapshot. */
  Snapshot: 2,
  /** `uint64 cutoff` and a kept bundle, the host to the relay. */
  Checkpoint: 3,
  /** `uint64 id` and an entry, the relay to a peer: a log entry. */
  Logged: 4,
  /** A kept bundle, the relay to a peer that joins or the host that returns. */
  Replay: 5,
  /** `uint64 tail`, the relay to a peer: the replay is over. */
  LogEnd: 6,
} as const

const U64 = 8

/** A message of this kind: the kind byte, then the parts. */
export function withKind(kind: number, ...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0))
  out[0] = kind
  let at = 1
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Splits a message into its kind and the payload after it, or undefined if it is empty. */
export function splitKind(data: Uint8Array): { kind: number; payload: Uint8Array } | undefined {
  const kind = data[0]
  return kind === undefined ? undefined : { kind, payload: data.subarray(1) }
}

/** An id, cutoff or tail on the wire: unsigned 64 bits, big-endian. */
export function encodeUint64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid number')
  const out = new Uint8Array(U64)
  new DataView(out.buffer).setBigUint64(0, BigInt(n))
  return out
}

/** Reverses encodeUint64 on the start of `data`; undefined if it is too short or too large. */
export function decodeUint64(data: Uint8Array): number | undefined {
  if (data.length < U64) return undefined
  const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(0)
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : undefined
}

/** A kind-4 message: a log entry with its id. */
export const encodeLogged = (id: number, entry: Uint8Array) =>
  withKind(Kind.Logged, encodeUint64(id), entry)

/** The id and entry of a kind-4 payload. */
export function decodeLogged(payload: Uint8Array): { id: number; entry: Uint8Array } | undefined {
  const id = decodeUint64(payload)
  return id === undefined ? undefined : { id, entry: payload.subarray(U64) }
}

/** A kind-6 message: the log's tail. */
export const encodeLogEnd = (tail: number) => withKind(Kind.LogEnd, encodeUint64(tail))

/** A kind-3 message: the entries up to `cutoff` are in `bundle`. */
export const encodeCheckpoint = (cutoff: number, bundle: Uint8Array) =>
  withKind(Kind.Checkpoint, encodeUint64(cutoff), bundle)

/** The cutoff and bundle of a kind-3 payload. */
export function decodeCheckpoint(
  payload: Uint8Array,
): { cutoff: number; bundle: Uint8Array } | undefined {
  const cutoff = decodeUint64(payload)
  return cutoff === undefined ? undefined : { cutoff, bundle: payload.subarray(U64) }
}

/**
 * The numbers after `word` in a relay text such as `kept 1700000000000`, or
 * undefined if the text is not of that word with exactly `count` numbers.
 */
export function parseNumbers(word: string, text: string, count: number): number[] | undefined {
  if (!text.startsWith(`${word} `)) return undefined
  const numbers = text
    .slice(word.length + 1)
    .split(' ')
    .map((p) => (/^\d{1,16}$/.test(p) ? Number(p) : Number.NaN))
  return numbers.length === count && numbers.every(Number.isSafeInteger) ? numbers : undefined
}

/**
 * The reason of the ROOM_CLOSED the relay sends when the host ended a room
 * kept without it (`pedit close`), so a guest can tell it from a room that
 * ended because its host left.
 */
export const HOST_CLOSED_REASON = 'the host closed the room'
