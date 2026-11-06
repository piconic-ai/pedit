import { type Awareness, removeAwarenessStates } from 'y-protocols/awareness'

/**
 * How long a peer may stay silent before it leaves the room. y-protocols
 * drops it after 30 s, but Chrome wakes the timers of a tab hidden for 5
 * minutes at most once a minute, so a guest in a background tab renews its
 * state only that often and would flicker in and out (#193). 90 s is one
 * throttled renewal plus slack; the host drops peers after the same
 * (internal/session/session.go).
 */
export const OUTDATED_TIMEOUT = 90_000

/** How often we renew our own state, as y-protocols does: older peers still drop us after 30 s. */
export const RENEW_INTERVAL = 15_000

const CHECK_INTERVAL = 3_000

/** An Awareness `update` event: also emitted when a client only renews its state. */
type Update = { added: number[]; updated: number[]; removed: number[] }

/**
 * Replaces the check y-protocols' Awareness runs on its own, whose timeout is
 * a module constant, with the same check under OUTDATED_TIMEOUT. It keeps its
 * own record of when each client was last heard from rather than reading
 * `meta.lastUpdated`, whose clock is lib0's.
 */
export function keepAlive(awareness: Awareness, timeout = OUTDATED_TIMEOUT): void {
  clearInterval(awareness._checkInterval)
  const heard = new Map<number, number>()
  for (const id of awareness.meta.keys()) heard.set(id, Date.now())
  awareness.on('update', ({ added, updated, removed }: Update) => {
    const now = Date.now()
    for (const id of [...added, ...updated]) heard.set(id, now)
    for (const id of removed) heard.delete(id)
  })
  const check = setInterval(() => {
    const now = Date.now()
    const local = awareness.getLocalState()
    if (local !== null && RENEW_INTERVAL <= now - (heard.get(awareness.clientID) ?? 0))
      awareness.setLocalState(local)
    const silent: number[] = []
    for (const [id, at] of heard) {
      if (id !== awareness.clientID && timeout <= now - at && awareness.states.has(id))
        silent.push(id)
    }
    if (silent.length > 0) removeAwarenessStates(awareness, silent, 'timeout')
  }, CHECK_INTERVAL)
  awareness._checkInterval = check
  awareness.on('destroy', () => clearInterval(check))
}
