import { describe, expect, it } from 'vitest'
import {
  encodeCanvas,
  encodeMessage,
  encrypt,
  frameBytes,
  generateKey,
  importKey,
  MAX_CANVAS_EDIT_BYTES,
  MAX_FRAME_BYTES,
  MESSAGE_TOO_BIG,
  MessageType,
} from '../src/index.ts'

describe('frame', () => {
  it('pins the limit the relay enforces', () => {
    // internal/protocol pins it too.
    expect(MAX_FRAME_BYTES).toBe(1048576)
    expect(MESSAGE_TOO_BIG).toBe(1009)
  })

  it('knows the size of an encrypted message on the wire', async () => {
    const key = await importKey(generateKey())
    for (const n of [0, 1, 1000]) {
      const frame = await encrypt(key, encodeMessage(MessageType.Sync, new Uint8Array(n)))
      expect(frame.length).toBe(frameBytes(n))
    }
  })

  it('fits the largest canvas edit', () => {
    const half = 'x'.repeat(MAX_CANVAS_EDIT_BYTES / 2)
    const payload = encodeCanvas({ kind: 'edit', id: 'e'.repeat(64), base: half, next: half })
    expect(frameBytes(payload.length)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
  })
})
