import { describe, expect, it } from 'vitest'
import {
  closeKeptLifetime,
  effectiveKeepSeconds,
  hostLeaves,
  hostReturns,
  keptDeadline,
  keptExpired,
  keptNextAlarm,
  PUBLIC_KEEP_MAX_SECONDS,
  startKeptLifetime,
} from '../src/kept-lifetime.ts'

describe('kept room lifetime', () => {
  it('clamps keep at the public cap and extends the old room limit', () => {
    expect(effectiveKeepSeconds(10 * 24 * 60 * 60, PUBLIC_KEEP_MAX_SECONDS)).toBe(
      PUBLIC_KEEP_MAX_SECONDS,
    )
    const start = startKeptLifetime(0, 24 * 60 * 60, 10 * 24 * 60 * 60)
    const left = hostLeaves(start, 23 * 60 * 60 * 1000, PUBLIC_KEEP_MAX_SECONDS)
    expect(left).toEqual({
      host: 'away',
      requestedSeconds: 10 * 24 * 60 * 60,
      keepSeconds: PUBLIC_KEEP_MAX_SECONDS,
      keepUntil: 23 * 60 * 60 * 1000 + PUBLIC_KEEP_MAX_SECONDS * 1000,
      totalUntil: 23 * 60 * 60 * 1000 + PUBLIC_KEEP_MAX_SECONDS * 1000,
    })
    const end = keptDeadline(left)!
    expect(keptExpired(left, end - 1)).toBe(false)
    expect(keptExpired(left, end)).toBe(true)
    expect(() => hostReturns(left, end)).toThrow()
  })

  it('starts a fresh absence period after a host returns and reapplies the cap', () => {
    const first = hostLeaves(startKeptLifetime(0, 120, 100), 1000, 80)
    const connected = hostReturns(first, 10_000)
    expect(keptDeadline(connected)).toBe(120_000)
    const second = hostLeaves(connected, 50_000, 60)
    expect(second).toEqual({
      host: 'away',
      requestedSeconds: 100,
      keepSeconds: 60,
      keepUntil: 110_000,
      totalUntil: 120_000,
    })
    const third = hostLeaves(hostReturns(second, 100_000), 110_000, 60)
    expect(third).toEqual({
      host: 'away',
      requestedSeconds: 100,
      keepSeconds: 60,
      keepUntil: 170_000,
      totalUntil: 170_000,
    })
  })

  it('keeps an unlimited self-hosted total lifetime while limiting each absence', () => {
    const open = startKeptLifetime(5, null, 100_000)
    const left = hostLeaves(open, 10, null)
    expect(left).toEqual({
      host: 'away',
      requestedSeconds: 100_000,
      keepSeconds: 100_000,
      keepUntil: 100_000_010,
      totalUntil: null,
    })
    expect(hostReturns(left, 100_000_009)).toEqual({
      host: 'connected',
      requestedSeconds: 100_000,
      totalUntil: null,
    })
  })

  it('uses the persisted deadline after restart and schedules the earlier alarm', () => {
    const left = hostLeaves(startKeptLifetime(0, 3600, 90), 1000, null)
    const restored: typeof left = JSON.parse(JSON.stringify(left))
    expect(keptNextAlarm(restored, 2000, 60)).toBe(62_000)
    expect(keptNextAlarm(restored, 62_000, 60)).toBe(91_000)
    expect(keptExpired(restored, 91_000)).toBe(true)
  })

  it('rejects invalid durations, clocks, overflow, and transitions after expiration', () => {
    for (const bad of [0, -1, 0.5, Infinity, Number.NaN]) {
      expect(() => startKeptLifetime(0, null, bad)).toThrow()
      expect(() => hostLeaves(startKeptLifetime(0, null, 1), 1, bad)).toThrow()
    }
    expect(() => hostLeaves(startKeptLifetime(0, null, Number.MAX_SAFE_INTEGER), 1, null)).toThrow()
    expect(
      keptDeadline(hostLeaves(startKeptLifetime(0, null, 1), 1, Number.MAX_SAFE_INTEGER)),
    ).toBe(1001)
    expect(() => startKeptLifetime(-1, null, 1)).toThrow()
    expect(() => startKeptLifetime(Number.MAX_SAFE_INTEGER, 1, 1)).toThrow()
    expect(() => hostLeaves(startKeptLifetime(0, 1, 1), 1000, null)).toThrow()
    const left = hostLeaves(startKeptLifetime(0, null, 1), 0, null)
    expect(() => hostLeaves(left, 1, null)).toThrow()
    expect(() => hostReturns(left, 1000)).toThrow()
    expect(() => keptNextAlarm(left, -1, 60)).toThrow()
    const closed = closeKeptLifetime(1000)
    expect(keptExpired(closed, 0)).toBe(true)
    expect(() => hostReturns(closed, 0)).toThrow()
    expect(() => hostLeaves(closed, 0, null)).toThrow()
    expect(() => keptNextAlarm(closed, 0, 60)).toThrow()
  })
})
