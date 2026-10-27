import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { keepAlive, OUTDATED_TIMEOUT, RENEW_INTERVAL } from '../src/expiry.ts'

// Chrome wakes the timers of a tab hidden for 5 minutes at most this often.
const THROTTLED_RENEWAL = 60_000

describe('keepAlive', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function room() {
    const here = new Awareness(new Y.Doc())
    keepAlive(here)
    const guest = new Awareness(new Y.Doc())
    guest.setLocalState({ user: { name: 'guest' } })
    const renew = () => {
      guest.setLocalState(guest.getLocalState())
      applyAwarenessUpdate(here, encodeAwarenessUpdate(guest, [guest.clientID]), 'relay')
    }
    renew()
    return { here, guest, renew }
  }

  it('keeps a guest in a background tab that renews once a minute', () => {
    const { here, guest, renew } = room()
    const removed: number[] = []
    here.on('change', (e: { removed: number[] }) => removed.push(...e.removed))
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(THROTTLED_RENEWAL)
      renew()
    }
    expect(removed).toEqual([])
    expect(here.getStates().has(guest.clientID)).toBe(true)
  })

  it('drops a guest that goes silent, after the timeout', () => {
    const { here, guest } = room()
    vi.advanceTimersByTime(OUTDATED_TIMEOUT - 5_000)
    expect(here.getStates().has(guest.clientID)).toBe(true)
    vi.advanceTimersByTime(10_000)
    expect(here.getStates().has(guest.clientID)).toBe(false)
  })

  it('renews its own state as often as y-protocols does', () => {
    const { here } = room()
    const clock = here.meta.get(here.clientID)?.clock ?? 0
    vi.advanceTimersByTime(RENEW_INTERVAL + 3_000)
    expect(here.meta.get(here.clientID)?.clock).toBeGreaterThan(clock)
  })

  it('stops checking once the awareness is destroyed', () => {
    const { here } = room()
    here.destroy()
    expect(vi.getTimerCount()).toBe(1) // the guest's own check
  })
})
