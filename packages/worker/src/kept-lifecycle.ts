import { DurableLog } from './durable-log.ts'
import { KeptAdmission } from './kept-admission.ts'
import {
  closeKeptLifetime,
  hostLeaves,
  hostReturns,
  type KeptLifetime,
  keptNextAlarm,
  observeKeptLifetime,
  restoreKeptLifetime,
  startKeptLifetime,
} from './kept-lifetime.ts'
import { ADMISSION_KEY } from './room-storage.ts'

const LIFETIME_KEY = 'keptLifetime'
export type KeepPolicy = {
  requestedSeconds: number
  roomMaxSeconds: number | null
  maxKeepSeconds: number | null
  alarmSeconds: number
}

function sameTransition(expected: KeptLifetime, current: KeptLifetime): boolean {
  if (current.observedAt < expected.observedAt || current.host !== expected.host) return false
  if (current.host === 'closed' && expected.host === 'closed') return true
  if (current.host === 'connected' && expected.host === 'connected')
    return (
      current.requestedSeconds === expected.requestedSeconds &&
      current.totalUntil === expected.totalUntil
    )
  if (current.host !== 'away' || expected.host !== 'away') return false
  return (
    current.requestedSeconds === expected.requestedSeconds &&
    current.totalUntil === expected.totalUntil &&
    current.departedAt === expected.departedAt &&
    current.keepUntil === expected.keepUntil &&
    current.keepSeconds === expected.keepSeconds
  )
}

export class KeptLifecycle {
  private readonly admission: KeptAdmission
  private lastObserved = 0
  constructor(
    private readonly state: DurableObjectState,
    namespace: Pick<Env['ROOM'], 'idFromName'>,
    private readonly policy: KeepPolicy,
    private readonly now: () => number = Date.now,
    private readonly maintenanceClosed: () => boolean = () => false,
  ) {
    this.admission = new KeptAdmission(state, namespace)
  }

  assertOpen(): void {
    if (this.maintenanceClosed()) throw new Error('room under maintenance')
    const raw = this.state.storage.kv.get(LIFETIME_KEY)
    if (raw === undefined) throw new Error('kept room not initialized')
    const current = restoreKeptLifetime(raw)
    const now = this.now()
    if (now < this.lastObserved) throw new Error('clock moved backwards')
    this.lastObserved = now
    const observed = observeKeptLifetime(current, now)
    if (observed.host === 'closed') throw new Error('kept room closed')
    if (observed.observedAt !== current.observedAt)
      this.state.storage.kv.put(LIFETIME_KEY, observed)
  }

  async start(roomId: string, hostToken: string): Promise<void> {
    await this.admission.authorizeHost(roomId, hostToken)
    await this.update((current, now) => {
      if (current) {
        if (
          current.host !== 'connected' ||
          current.requestedSeconds !== this.policy.requestedSeconds
        )
          throw new Error('kept room already initialized')
        return observeKeptLifetime(current, now)
      }
      return startKeptLifetime(now, this.policy.roomMaxSeconds, this.policy.requestedSeconds)
    })
    this.assertOpen()
  }

  async leave(roomId: string, hostToken: string): Promise<KeptLifetime> {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.update((current, now) =>
      hostLeaves(this.required(current), now, this.policy.maxKeepSeconds),
    )
  }

  async resume(roomId: string, hostToken: string): Promise<KeptLifetime> {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.update((current, now) => hostReturns(this.required(current), now))
  }

  async close(roomId: string, hostToken: string): Promise<KeptLifetime> {
    await this.admission.authorizeHost(roomId, hostToken)
    return this.update((current, now) => closeKeptLifetime(this.required(current), now))
  }

  async observe(): Promise<KeptLifetime> {
    return this.update((current, now) => {
      const state = this.required(current)
      return observeKeptLifetime(state, now)
    })
  }

  async rememberObservation(): Promise<void> {
    if (!this.lastObserved) return
    await this.update((current) => {
      const state = this.required(current)
      return observeKeptLifetime(state, Math.max(state.observedAt, this.lastObserved))
    }, true)
  }

  private required(current: KeptLifetime | undefined): KeptLifetime {
    if (!current) throw new Error('kept room not initialized')
    return current
  }

  private async update(
    change: (current: KeptLifetime | undefined, now: number) => KeptLifetime,
    preserveObservation = false,
  ): Promise<KeptLifetime> {
    const storage = this.state.storage
    const next = await storage.transaction(async () => {
      const raw = storage.kv.get(LIFETIME_KEY)
      const current = raw === undefined ? undefined : restoreKeptLifetime(raw)
      if (storage.kv.get(ADMISSION_KEY) === undefined) {
        if (current?.host === 'closed') return current
        throw new Error('room admission closed')
      }
      const wallTime = this.now()
      if (!preserveObservation && wallTime < this.lastObserved)
        throw new Error('clock moved backwards')
      const now = preserveObservation ? Math.max(wallTime, this.lastObserved) : wallTime
      this.lastObserved = now
      const state = this.maintenanceClosed()
        ? closeKeptLifetime(this.required(current), now)
        : change(current, now)
      if (state.host === 'closed') {
        DurableLog.clear(storage)
        storage.kv.delete(ADMISSION_KEY)
      } else {
        const deadline = keptNextAlarm(state, this.policy.alarmSeconds)
        const old = await storage.getAlarm()
        if (old === null || deadline < old) await storage.setAlarm(deadline)
      }
      storage.kv.put(LIFETIME_KEY, state)
      return state
    })
    await storage.sync()
    const stored = storage.kv.get(LIFETIME_KEY)
    if (stored === undefined) throw new Error('kept lifetime changed')
    const current = restoreKeptLifetime(stored)
    if (!sameTransition(next, current)) throw new Error('kept lifetime changed')
    if (current.host !== 'closed') this.assertOpen()
    return current
  }
}
