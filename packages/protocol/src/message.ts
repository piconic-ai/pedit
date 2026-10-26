export const MessageType = {
  Sync: 0,
  Awareness: 1,
  Attachment: 2,
  Canvas: 3,
  Files: 4,
  // 5 marks a signed message (signed.ts).
  /** Asks peers to show they are live, and answers a peer's asking (fresh.ts). */
  Fresh: 6,
} as const
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export interface Message {
  type: MessageType
  payload: Uint8Array
}

/**
 * A message type this version does not know, from a newer peer. Clients skip
 * such messages instead of reporting them.
 */
export class UnknownMessageTypeError extends Error {
  // Not a parameter property: Node.js strips types but cannot run those.
  readonly messageType: number

  constructor(messageType: number) {
    super(`unknown message type: ${messageType}`)
    this.name = 'UnknownMessageTypeError'
    this.messageType = messageType
  }
}

const TYPES: ReadonlySet<number> = new Set(Object.values(MessageType))

/** Prefixes a payload with a one-byte message type. */
export function encodeMessage(type: MessageType, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.length)
  out[0] = type
  out.set(payload, 1)
  return out
}

export function decodeMessage(data: Uint8Array): Message {
  const type = data[0]
  if (type === undefined) throw new Error('empty message')
  if (!TYPES.has(type)) throw new UnknownMessageTypeError(type)
  return { type: type as MessageType, payload: data.subarray(1) }
}
