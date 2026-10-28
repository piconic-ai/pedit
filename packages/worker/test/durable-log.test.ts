import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { DurableLog, LogClosedError, LogFullError } from '../src/durable-log.ts'
import type { Room } from '../src/room.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

const bytes = (...values: number[]) => new Uint8Array(values).buffer
const limits = { bytes: 5, frames: 2 }
const open = (storage: DurableObjectStorage) => storage.kv.put(ADMISSION_KEY, bytes(1))

describe('durable ciphertext log', () => {
  it('retains ordered frames across eviction and deduplicates a retry', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    const first = await runInDurableObject(stub, async (_: Room, state) => {
      open(state.storage)
      const log = new DurableLog(state.storage, limits)
      const a = await log.append('one', bytes(1, 2))
      expect(await log.append('one', bytes(1, 2))).toBe(a)
      const b = await log.append('one', bytes(3))
      expect(b).toBeGreaterThan(a)
      await expect(log.append('one', bytes(4))).rejects.toBeInstanceOf(LogFullError)
      return a
    })
    await evictDurableObject(stub)
    await runInDurableObject(stub, async (_: Room, state) => {
      const log = new DurableLog(state.storage, limits)
      const rows = log.read('one', first, 10)
      expect(rows).toHaveLength(1)
      expect([...new Uint8Array(rows[0]?.ciphertext ?? new ArrayBuffer(0))]).toEqual([3])
      DurableLog.clear(state.storage)
      DurableLog.clear(state.storage)
      expect(log.read('one', 0, 10)).toHaveLength(0)
      await expect(log.append('one', bytes(9))).rejects.toBeInstanceOf(LogClosedError)
    })
  })

  it('rejects an append if the room closes during hashing', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      open(state.storage)
      const log = new DurableLog(state.storage, limits)
      const digest = crypto.subtle.digest.bind(crypto.subtle)
      let resume!: () => void
      const wait = new Promise<void>((resolve) => {
        resume = resolve
      })
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
        await wait
        return digest(algorithm, data)
      })
      try {
        const pending = log.append('one', bytes(1))
        DurableLog.clear(state.storage)
        resume()
        await expect(pending).rejects.toBeInstanceOf(LogClosedError)
        expect(log.read('one', 0, 10)).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })
  })

  it('does not acknowledge a frame if the room closes during storage sync', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      open(state.storage)
      const log = new DurableLog(state.storage, limits)
      let resume!: () => void
      let entered!: () => void
      const wait = new Promise<void>((resolve) => {
        resume = resolve
      })
      const syncing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const sync = state.storage.sync.bind(state.storage)
      const spy = vi.spyOn(state.storage, 'sync').mockImplementation(async () => {
        entered()
        await wait
        await sync()
      })
      try {
        const pending = log.append('one', bytes(1))
        await syncing
        DurableLog.clear(state.storage)
        resume()
        await expect(pending).rejects.toBeInstanceOf(LogClosedError)
        expect(log.read('one', 0, 10)).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })
  })

  it('enforces the quota when appends race', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      open(state.storage)
      const log = new DurableLog(state.storage, { bytes: 1, frames: 1 })
      const results = await Promise.allSettled([
        log.append('one', bytes(1)),
        log.append('one', bytes(2)),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(log.read('one', 0, 10)).toHaveLength(1)
    })
  })

  it('does not acknowledge a failed sync and can retry the same frame', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      open(state.storage)
      const log = new DurableLog(state.storage, limits)
      const spy = vi.spyOn(state.storage, 'sync').mockRejectedValueOnce(new Error('sync failed'))
      try {
        await expect(log.append('one', bytes(1))).rejects.toThrow('sync failed')
      } finally {
        spy.mockRestore()
      }
      const sequence = await log.append('one', bytes(1))
      expect(log.read('one', 0, 10).map((entry) => entry.sequence)).toEqual([sequence])
    })
  })

  it('counts bytes and separates epochs and rooms', async () => {
    const first = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    const second = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(first, async (_: Room, state) => {
      open(state.storage)
      const log = new DurableLog(state.storage, limits)
      await log.append('one', bytes(1, 2, 3))
      await expect(log.append('two', bytes(1, 2, 3))).rejects.toBeInstanceOf(LogFullError)
      expect(log.read('two', 0, 10)).toHaveLength(0)
      await expect(log.append('one', new ArrayBuffer(0))).rejects.toThrow('invalid durable frame')
    })
    await runInDurableObject(second, async (_: Room, state) => {
      open(state.storage)
      const log = new DurableLog(state.storage, limits)
      expect(log.read('one', 0, 10)).toHaveLength(0)
      const a = await log.append('one', bytes(1))
      const b = await log.append('two', bytes(1))
      expect(b).toBeGreaterThan(a)
      expect(log.read('two', 0, 10).map((entry) => entry.sequence)).toEqual([b])
      expect(() => log.read('one', 0, -1)).toThrow('invalid durable log range')
      expect(() => log.read('one', 0, 17)).toThrow('invalid durable log range')
    })
  })
})
