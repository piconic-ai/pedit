export const PUBLIC_KEEP_MAX_SECONDS = 7 * 24 * 60 * 60

type Clock = { observedAt: number }
export type KeptLifetime = Clock &
  (
    | { host: 'connected'; requestedSeconds: number; totalUntil: number | null }
    | {
        host: 'away'
        requestedSeconds: number
        totalUntil: number | null
        departedAt: number
        keepUntil: number
        keepSeconds: number
      }
    | { host: 'closed' }
  )

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function deadline(now: number, seconds: number): number {
  if (!validTime(now) || !validDuration(seconds)) throw new Error('invalid lifetime')
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
  if (!validDuration(requestedSeconds)) throw new Error('invalid keep duration')
  return {
    host: 'connected',
    observedAt: openedAt,
    requestedSeconds,
    totalUntil: roomMaxSeconds === null ? null : deadline(openedAt, roomMaxSeconds),
  }
}

export function restoreKeptLifetime(value: unknown): KeptLifetime {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid lifetime')
  const row = value as Record<string, unknown>
  if (!validTime(row.observedAt)) throw new Error('invalid lifetime')
  if (row.host === 'closed') return { host: 'closed', observedAt: row.observedAt }
  if (
    !validDuration(row.requestedSeconds) ||
    !(row.totalUntil === null || validTime(row.totalUntil))
  )
    throw new Error('invalid lifetime')
  if (row.totalUntil !== null && row.totalUntil <= row.observedAt)
    throw new Error('invalid lifetime')
  if (row.host === 'connected')
    return {
      host: 'connected',
      observedAt: row.observedAt,
      requestedSeconds: row.requestedSeconds,
      totalUntil: row.totalUntil,
    }
  if (
    row.host !== 'away' ||
    !validTime(row.departedAt) ||
    !validTime(row.keepUntil) ||
    !validDuration(row.keepSeconds)
  )
    throw new Error('invalid lifetime')
  if (
    row.departedAt > row.observedAt ||
    row.keepUntil <= row.observedAt ||
    row.keepSeconds > row.requestedSeconds ||
    deadline(row.departedAt, row.keepSeconds) !== row.keepUntil ||
    (row.totalUntil !== null && row.totalUntil < row.keepUntil)
  )
    throw new Error('invalid lifetime')
  return {
    host: 'away',
    observedAt: row.observedAt,
    requestedSeconds: row.requestedSeconds,
    totalUntil: row.totalUntil,
    departedAt: row.departedAt,
    keepUntil: row.keepUntil,
    keepSeconds: row.keepSeconds,
  }
}

export function keptDeadline(state: KeptLifetime): number | null {
  if (state.host === 'closed') return null
  return state.host === 'away' ? state.keepUntil : state.totalUntil
}

export function observeKeptLifetime(state: KeptLifetime, now: number): KeptLifetime {
  if (!validTime(now) || now < state.observedAt) throw new Error('clock moved backwards')
  const until = keptDeadline(state)
  if (state.host === 'closed' || (until !== null && now >= until))
    return { host: 'closed', observedAt: now }
  return { ...state, observedAt: now }
}

export function effectiveKeepSeconds(
  requestedSeconds: number,
  maxKeepSeconds: number | null,
): number {
  if (!validDuration(requestedSeconds)) throw new Error('invalid keep duration')
  if (maxKeepSeconds !== null && !validDuration(maxKeepSeconds))
    throw new Error('invalid keep limit')
  return maxKeepSeconds === null ? requestedSeconds : Math.min(requestedSeconds, maxKeepSeconds)
}

export function closeKeptLifetime(state: KeptLifetime, now: number): KeptLifetime {
  observeKeptLifetime(state, now)
  return { host: 'closed', observedAt: now }
}

export function hostLeaves(
  state: KeptLifetime,
  now: number,
  maxKeepSeconds: number | null,
): KeptLifetime {
  const observed = observeKeptLifetime(state, now)
  if (observed.host === 'closed') return observed
  if (observed.host !== 'connected') throw new Error('host is already away')
  const keepSeconds = effectiveKeepSeconds(observed.requestedSeconds, maxKeepSeconds)
  const keepUntil = deadline(now, keepSeconds)
  return {
    host: 'away',
    observedAt: now,
    requestedSeconds: observed.requestedSeconds,
    keepSeconds,
    departedAt: now,
    keepUntil,
    totalUntil: observed.totalUntil === null ? null : Math.max(observed.totalUntil, keepUntil),
  }
}

export function hostReturns(state: KeptLifetime, now: number): KeptLifetime {
  const observed = observeKeptLifetime(state, now)
  if (observed.host === 'closed') return observed
  if (observed.host !== 'away') throw new Error('host is already connected')
  return {
    host: 'connected',
    observedAt: now,
    requestedSeconds: observed.requestedSeconds,
    totalUntil: observed.totalUntil,
  }
}

export function keptNextAlarm(state: KeptLifetime, intervalSeconds: number): number {
  if (state.host === 'closed') throw new Error('room is not open')
  if (!validDuration(intervalSeconds)) throw new Error('invalid lifetime')
  const until = keptDeadline(state)
  if (until !== null && intervalSeconds >= (until - state.observedAt) / 1000) return until
  return deadline(state.observedAt, intervalSeconds)
}
