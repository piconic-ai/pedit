import { describe, expect, it } from 'vitest'
import {
  decodeFrame,
  encodeCanvas,
  encodeFrame,
  encodeMessage,
  encrypt,
  frameBytes,
  generateKey,
  importKey,
  MAX_CANVAS_EDIT_BYTES,
  MAX_FRAME_BYTES,
  MESSAGE_TOO_BIG,
  MessageType,
  ReplayGuard,
  SENDER_BYTES,
} from '../src/index.ts'
import { editKeys, sealFrame } from '../src/testing.ts'

describe('frame', () => {
  it('pins the limit the relay enforces', () => {
    // internal/protocol pins it too.
    expect(MAX_FRAME_BYTES).toBe(1048576)
    expect(MESSAGE_TOO_BIG).toBe(1009)
  })

  it('knows the size of an encrypted message on the wire', async () => {
    const keys = await editKeys()
    for (const n of [0, 1, 1000]) {
      const message = encodeMessage(MessageType.Sync, new Uint8Array(n))
      const sender = new Uint8Array(SENDER_BYTES)
      const frame = await sealFrame(keys, sender, 1, message)
      expect(frame.length).toBe(frameBytes(n))
      // A read link's frames carry no signature.
      const plain = await encrypt(keys.frameKey, encodeFrame(sender, 1, message))
      expect(plain.length).toBeLessThan(frame.length)
    }
  })

  it('fits the largest canvas edit', () => {
    const half = 'x'.repeat(MAX_CANVAS_EDIT_BYTES / 2)
    const payload = encodeCanvas({ kind: 'edit', id: 'e'.repeat(64), base: half, next: half })
    expect(frameBytes(payload.length)).toBeLessThanOrEqual(MAX_FRAME_BYTES)
  })

  it('puts the sender and counter before the message, as internal/protocol does', () => {
    const sender = new Uint8Array(SENDER_BYTES).fill(7)
    const data = encodeFrame(sender, 2 ** 40 + 5, new Uint8Array([MessageType.Sync, 9]))
    expect(Array.from(data.subarray(SENDER_BYTES, SENDER_BYTES + 8))).toEqual([
      0, 0, 1, 0, 0, 0, 0, 5,
    ])
    const frame = decodeFrame(data)
    expect(frame.sender).toEqual(sender)
    expect(frame.counter).toBe(2n ** 40n + 5n)
    expect(Array.from(frame.message)).toEqual([MessageType.Sync, 9])
    expect(() => decodeFrame(data.subarray(0, SENDER_BYTES + 7))).toThrow()
  })

  it('takes each frame from a sender once, never our own', () => {
    const of = (n: number) => new Uint8Array(SENDER_BYTES).fill(n)
    const guard = new ReplayGuard(of(9))
    expect(guard.accept('edit', of(1), 1n)).toBe(true)
    expect(guard.accept('edit', of(1), 1n)).toBe(false)
    expect(guard.accept('edit', of(1), 3n)).toBe(true) // one lost on the way is fine
    expect(guard.accept('edit', of(1), 2n)).toBe(false)
    expect(guard.accept('edit', of(2), 1n)).toBe(true)
    expect(guard.accept('edit', of(1), 0n)).toBe(false)
    expect(guard.accept('edit', of(9), 100n)).toBe(false)
    expect(guard.foreign(of(9))).toBe(false)
    expect(guard.foreign(of(1))).toBe(true)
  })

  it('counts each tier apart, so a lower one cannot move a higher one', () => {
    const of = (n: number) => new Uint8Array(SENDER_BYTES).fill(n)
    const guard = new ReplayGuard(of(9))
    // A commenter that names an editor's sender, with a counter far ahead.
    expect(guard.accept('comment', of(1), 2n ** 63n)).toBe(true)
    expect(guard.accept('edit', of(1), 1n)).toBe(true)
    expect(guard.accept('edit', of(1), 2n)).toBe(true)
  })
})
