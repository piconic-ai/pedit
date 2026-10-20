import { describe, expect, it } from 'vitest'
// Also read by the Go side (internal/protocol/close_test.go), so both agree.
import vectors from '../../testdata/close-codes.json'
import * as close from '../src/close.ts'
import { expiredReason, parseExpiredReason } from '../src/close.ts'

describe('close codes', () => {
  it('match the shared vectors, name for name', () => {
    const exported = Object.fromEntries(
      Object.entries(close).filter(([, value]) => typeof value === 'number'),
    )
    expect(exported).toEqual(vectors.codes)
  })

  it('match the shared relay signals, name for name', () => {
    const exported = Object.fromEntries(
      Object.entries(close).filter(([, value]) => typeof value === 'string'),
    )
    expect(exported).toEqual(vectors.signals)
  })

  it('writes and reads the reason of an expired room', () => {
    for (const c of vectors.expiredReasons) {
      expect(expiredReason(c.seconds)).toBe(c.reason)
      expect(parseExpiredReason(c.reason)).toBe(c.seconds)
    }
  })

  it('reads no limit out of other reasons', () => {
    for (const reason of vectors.unparsed) expect(parseExpiredReason(reason)).toBeUndefined()
    expect(parseExpiredReason(undefined)).toBeUndefined()
  })
})
