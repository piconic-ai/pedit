/**
 * The most bytes one frame may have on the wire: one WebSocket message,
 * encrypted. The relay closes a connection that sends a larger one with
 * MESSAGE_TOO_BIG, and RoomClient never sends one. Keep it equal to
 * MaxFrameBytes in internal/protocol.
 */
export const MAX_FRAME_BYTES = 1024 * 1024

/** What a frame adds to its payload: the message type byte, and AES-GCM's 12-byte IV and 16-byte tag. */
export const FRAME_OVERHEAD = 1 + 12 + 16

/** The size on the wire of a frame carrying `payload` bytes. */
export function frameBytes(payload: number): number {
  return payload + FRAME_OVERHEAD
}
