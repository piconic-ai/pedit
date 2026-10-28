export const PUBLIC_KEEP_MAX_SECONDS = 7 * 24 * 60 * 60

export type KeptLifetime =
  | { host: 'connected'; requestedSeconds: number; totalUntil: number | null }
  | {
      host: 'away'
      requestedSeconds: number
      totalUntil: number | null
      keepUntil: number
      keepSeconds: number
    }
  | { host: 'closed'; closedAt: number }

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function deadline(now: number, seconds: number): number {
  if (!validTime(now) || !Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error('invalid lifetime')
  }
  const value = now + seconds * 1000
  if (!Number.isSafeInteger(value)) throw new Error('invalid lifetime')
  return value
}

export function startKeptLifetime(
  openedAt: number,
  roomMaxSeconds: number | null,
  requestedSeconds: number,
): KeptLifetime {
  if (!validTime(openedAt)) throw new Error('invalid lifetime')
  if (!Number.isSafeInteger(requestedSeconds) || requestedSeconds <= 0)
    throw new Error('invalid keep duration')
  return {
    host: 'connected',
    requestedSeconds,
    totalUntil: roomMaxSeconds === null ? null : deadline(openedAt, roomMaxSeconds),
  }
}

export function keptDeadline(state: KeptLifetime): number | null {
  if (state.host === 'closed') return null
  return state.host === 'away' ? state.keepUntil : state.totalUntil
}

export function keptExpired(state: KeptLifetime, now: number): boolean {
  if (!validTime(now)) throw new Error('invalid lifetime')
  if (state.host === 'closed') return true
  const until = keptDeadline(state)
  return until !== null && now >= until
}

export function effectiveKeepSeconds(
  requestedSeconds: number,
  maxKeepSeconds: number | null,
): number {
  if (!Number.isSafeInteger(requestedSeconds) || requestedSeconds <= 0)
    throw new Error('invalid keep duration')
  if (maxKeepSeconds !== null && (!Number.isSafeInteger(maxKeepSeconds) || maxKeepSeconds <= 0))
    throw new Error('invalid keep limit')
  return maxKeepSeconds === null ? requestedSeconds : Math.min(requestedSeconds, maxKeepSeconds)
}

export function closeKeptLifetime(now: number): KeptLifetime {
  if (!validTime(now)) throw new Error('invalid lifetime')
  return { host: 'closed', closedAt: now }
}

export function hostLeaves(
  state: KeptLifetime,
  now: number,
  maxKeepSeconds: number | null,
): KeptLifetime {
  if (state.host !== 'connected' || keptExpired(state, now)) throw new Error('room is not open')
  const keepSeconds = effectiveKeepSeconds(state.requestedSeconds, maxKeepSeconds)
  const keepUntil = deadline(now, keepSeconds)
  return {
    host: 'away',
    requestedSeconds: state.requestedSeconds,
    keepSeconds,
    keepUntil,
    totalUntil: state.totalUntil === null ? null : Math.max(state.totalUntil, keepUntil),
  }
}

export function hostReturns(state: KeptLifetime, now: number): KeptLifetime {
  if (state.host !== 'away' || keptExpired(state, now)) throw new Error('room is not open')
  return {
    host: 'connected',
    requestedSeconds: state.requestedSeconds,
    totalUntil: state.totalUntil,
  }
}

export function keptNextAlarm(state: KeptLifetime, now: number, intervalSeconds: number): number {
  if (state.host === 'closed') throw new Error('room is not open')
  const check = deadline(now, intervalSeconds)
  const until = keptDeadline(state)
  return until === null ? check : Math.min(until, check)
}
