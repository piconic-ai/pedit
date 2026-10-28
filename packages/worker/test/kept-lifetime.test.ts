import { describe, expect, it } from 'vitest'
import {
  closeKeptLifetime,
  effectiveKeepSeconds,
  hostLeaves,
  hostReturns,
  keptNextAlarm,
  observeKeptLifetime,
  PUBLIC_KEEP_MAX_SECONDS,
  restoreKeptLifetime,
  startKeptLifetime,
} from '../src/kept-lifetime.ts'

describe('kept room lifetime', () => {
  it('clamps keep at the public cap and extends the old room limit', () => {
    expect(effectiveKeepSeconds(864_000, PUBLIC_KEEP_MAX_SECONDS)).toBe(PUBLIC_KEEP_MAX_SECONDS)
    const start = startKeptLifetime(0, 86_400, 864_000)
    const left = hostLeaves(start, 82_800_000, PUBLIC_KEEP_MAX_SECONDS)
    const until = 82_800_000 + PUBLIC_KEEP_MAX_SECONDS * 1000
    expect(left).toEqual({
      host: 'away',
      observedAt: 82_800_000,
      departedAt: 82_800_000,
      requestedSeconds: 864_000,
      keepSeconds: PUBLIC_KEEP_MAX_SECONDS,
      keepUntil: until,
      totalUntil: until,
    })
    expect(observeKeptLifetime(left, until - 1).host).toBe('away')
    expect(observeKeptLifetime(left, until)).toEqual({ host: 'closed', observedAt: until })
    expect(hostReturns(left, until)).toEqual({ host: 'closed', observedAt: until })
  })

  it('starts a fresh absence period after a return and reapplies the cap', () => {
    const first = hostLeaves(startKeptLifetime(0, 120, 100), 1000, 80)
    const connected = hostReturns(first, 10_000)
    const second = hostLeaves(connected, 50_000, 60)
    expect(second).toEqual({
      host: 'away',
      observedAt: 50_000,
      departedAt: 50_000,
      requestedSeconds: 100,
      keepSeconds: 60,
      keepUntil: 110_000,
      totalUntil: 120_000,
    })
    const third = hostLeaves(hostReturns(second, 100_000), 110_000, 60)
    expect(third).toEqual({
      host: 'away',
      observedAt: 110_000,
      departedAt: 110_000,
      requestedSeconds: 100,
      keepSeconds: 60,
      keepUntil: 170_000,
      totalUntil: 170_000,
    })
  })

  it('keeps unlimited self-hosted total lifetime while limiting each absence', () => {
    const left = hostLeaves(startKeptLifetime(5, null, 100_000), 10, null)
    expect(left).toEqual({
      host: 'away',
      observedAt: 10,
      departedAt: 10,
      requestedSeconds: 100_000,
      keepSeconds: 100_000,
      keepUntil: 100_000_010,
      totalUntil: null,
    })
    expect(hostReturns(left, 100_000_009)).toEqual({
      host: 'connected',
      observedAt: 100_000_009,
      requestedSeconds: 100_000,
      totalUntil: null,
    })
  })

  it('preserves observed time across restart and chooses the earlier alarm', () => {
    const left = hostLeaves(startKeptLifetime(0, 3600, 90), 1000, null)
    const restored = restoreKeptLifetime(JSON.parse(JSON.stringify(left)))
    const tick = observeKeptLifetime(restored, 2000)
    expect(keptNextAlarm(tick, 60)).toBe(62_000)
    const next = observeKeptLifetime(tick, 62_000)
    expect(keptNextAlarm(next, 60)).toBe(91_000)
    expect(observeKeptLifetime(next, 91_000)).toEqual({ host: 'closed', observedAt: 91_000 })
  })

  it('schedules a finite deadline even when the heartbeat would overflow', () => {
    const start = Number.MAX_SAFE_INTEGER - 1000
    const finite = startKeptLifetime(start, 1, 1)
    expect(keptNextAlarm(finite, 60)).toBe(Number.MAX_SAFE_INTEGER)
    expect(keptNextAlarm(finite, 1)).toBe(Number.MAX_SAFE_INTEGER)
    expect(() => keptNextAlarm(startKeptLifetime(start, null, 1), 60)).toThrow()
    expect(() => keptNextAlarm(finite, 0)).toThrow()
  })

  it('rejects clock rollback on every operation, including after restore and close', () => {
    const left = hostLeaves(startKeptLifetime(100_000, 100, 60), 101_000, null)
    expect(() => hostReturns(left, 1000)).toThrow('clock moved backwards')
    const observed = observeKeptLifetime(left, 102_000)
    const restored = restoreKeptLifetime(JSON.parse(JSON.stringify(observed)))
    expect(() => observeKeptLifetime(restored, 101_999)).toThrow('clock moved backwards')
    expect(() => closeKeptLifetime(restored, 101_999)).toThrow('clock moved backwards')
    const closed = closeKeptLifetime(restored, 102_001)
    expect(() => hostReturns(closed, 1)).toThrow('clock moved backwards')
    expect(hostReturns(closed, 102_002)).toEqual({ host: 'closed', observedAt: 102_002 })
  })

  it('rejects malformed and inconsistent restored state', () => {
    const left = hostLeaves(startKeptLifetime(1000, 200, 90), 2000, 80)
    expect(restoreKeptLifetime(JSON.parse(JSON.stringify(left)))).toEqual(left)
    for (const bad of [
      null,
      [],
      {},
      { host: 'closed', observedAt: -1 },
      { host: 'connected', observedAt: 5, requestedSeconds: 0, totalUntil: null },
      { host: 'connected', observedAt: 5, requestedSeconds: 1, totalUntil: 5 },
      { ...left, host: 'unknown' },
      { ...left, keepUntil: 'bad' },
      { ...left, keepUntil: 1000 },
      { ...left, departedAt: 3000 },
      { ...left, keepSeconds: 91 },
      { ...left, totalUntil: 80_000 },
      { ...left, keepUntil: 82_001 },
    ])
      expect(() => restoreKeptLifetime(bad)).toThrow()
  })

  it('rejects invalid inputs and integer overflow', () => {
    for (const bad of [0, -1, 0.5, Infinity, Number.NaN]) {
      expect(() => startKeptLifetime(0, null, bad)).toThrow()
      expect(() => hostLeaves(startKeptLifetime(0, null, 1), 1, bad)).toThrow()
    }
    expect(() => hostLeaves(startKeptLifetime(0, null, Number.MAX_SAFE_INTEGER), 1, null)).toThrow()
    expect(() => startKeptLifetime(-1, null, 1)).toThrow()
    expect(() => startKeptLifetime(Number.MAX_SAFE_INTEGER, 1, 1)).toThrow()
    expect(hostLeaves(startKeptLifetime(0, 1, 1), 1000, null)).toEqual({
      host: 'closed',
      observedAt: 1000,
    })
    const left = hostLeaves(startKeptLifetime(0, null, 1), 0, null)
    expect(() => hostLeaves(left, 1, null)).toThrow()
    expect(keptNextAlarm(left, 1)).toBe(1000)
  })
})
