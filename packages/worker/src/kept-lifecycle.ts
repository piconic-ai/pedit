import { DurableLog } from './durable-log.ts'
import { KeptAdmission } from './kept-admission.ts'
import { KeptBlobCleanup } from './kept-blob-cleanup.ts'
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

export const LIFETIME_KEY = 'keptLifetime'
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
  static async observeAlarm(
    state: DurableObjectState,
    namespace: Pick<Env['ROOM'], 'idFromName'>,
    alarmSeconds: number,
    maintenanceClosed: () => boolean,
  ): Promise<KeptLifetime> {
    return new KeptLifecycle(
      state,
      namespace,
      { requestedSeconds: 1, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds },
      Date.now,
      maintenanceClosed,
    ).observe()
  }
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
    if (observed.observedAt !== current.observedAt || observed.host === 'closed')
      this.state.storage.kv.put(LIFETIME_KEY, observed)
    if (observed.host === 'closed') throw new Error('kept room closed')
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

  async reconcileHost(isPresent: () => boolean): Promise<KeptLifetime> {
    return this.update((current, now) => {
      const observed = observeKeptLifetime(this.required(current), now)
      if (observed.host === 'closed') return observed
      if (isPresent()) return observed.host === 'away' ? hostReturns(observed, now) : observed
      return observed.host === 'connected'
        ? hostLeaves(observed, now, this.policy.maxKeepSeconds)
        : observed
    })
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
    const wallTime = this.now()
    if (!preserveObservation && wallTime < this.lastObserved)
      throw new Error('clock moved backwards')
    let now = preserveObservation ? Math.max(wallTime, this.lastObserved) : wallTime
    this.lastObserved = now
    const rawBefore = storage.kv.get(LIFETIME_KEY)
    if (rawBefore !== undefined && storage.kv.get(ADMISSION_KEY) !== undefined) {
      const before = restoreKeptLifetime(rawBefore)
      const observed = observeKeptLifetime(before, now)
      if (observed.observedAt !== before.observedAt || observed.host === 'closed')
        storage.kv.put(LIFETIME_KEY, observed)
    }
    let next: KeptLifetime
    try {
      next = await storage.transaction(async () => {
        const admittedAt = this.now()
        if (!preserveObservation && admittedAt < this.lastObserved)
          throw new Error('clock moved backwards')
        now = preserveObservation ? Math.max(admittedAt, this.lastObserved) : admittedAt
        this.lastObserved = now
        const raw = storage.kv.get(LIFETIME_KEY)
        const current = raw === undefined ? undefined : restoreKeptLifetime(raw)
        if (storage.kv.get(ADMISSION_KEY) === undefined) {
          if (current?.host === 'closed') return current
          throw new Error('room admission closed')
        }
        const state = this.maintenanceClosed()
          ? closeKeptLifetime(this.required(current), now)
          : change(current, now)
        if (state.host === 'closed') {
          DurableLog.clear(storage)
          storage.kv.delete(ADMISSION_KEY)
          await KeptBlobCleanup.closeForLifetime(storage)
        } else {
          const deadline = keptNextAlarm(state, this.policy.alarmSeconds)
          const old = await storage.getAlarm()
          if (old === null || deadline < old) await storage.setAlarm(deadline)
        }
        storage.kv.put(LIFETIME_KEY, state)
        return state
      })
    } catch (error) {
      const raw = storage.kv.get(LIFETIME_KEY)
      if (raw !== undefined && storage.kv.get(ADMISSION_KEY) !== undefined) {
        const current = restoreKeptLifetime(raw)
        const observed = observeKeptLifetime(
          current,
          Math.max(current.observedAt, this.lastObserved),
        )
        if (observed.observedAt !== current.observedAt || observed.host === 'closed')
          storage.kv.put(LIFETIME_KEY, observed)
      }
      await storage.sync()
      throw error
    }
    await storage.sync()
    const stored = storage.kv.get(LIFETIME_KEY)
    if (stored === undefined) throw new Error('kept lifetime changed')
    const current = restoreKeptLifetime(stored)
    if (!sameTransition(next, current)) throw new Error('kept lifetime changed')
    if (current.host !== 'closed') this.assertOpen()
    return current
  }
}
