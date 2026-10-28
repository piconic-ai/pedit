import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  DurableLog,
  LogClosedError,
  LogFrozenError,
  StaleCheckpointError,
} from '../src/durable-log.ts'
import type { Room } from '../src/room.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

const bytes = (...values: number[]) => new Uint8Array(values).buffer
const readAll = async (log: DurableLog) => {
  const snapshot = await log.beginRead()
  return (await log.readPage(snapshot.session, snapshot.cursor)).entries
}

describe('checkpoint cutover', () => {
  it('requires an initial checkpoint before accepting a durable frame', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await expect(log.append('first', bytes(2))).rejects.toBeInstanceOf(StaleCheckpointError)
    })
  })
  it('freezes appends and atomically replaces a checkpoint and its covered log', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await log.initialize('first', bytes(1))
      const sequence = await log.append('first', bytes(2))
      const oldRead = await log.beginRead()
      const cut = await log.freeze('first', 1)
      expect(cut.cutoff).toBe(sequence)
      await expect(log.append('first', bytes(3))).rejects.toBeInstanceOf(LogFrozenError)
      await log.commit(cut, 'second', bytes(4))
      expect(log.checkpoint()).toMatchObject({ epoch: 'second', generation: 2, cutoff: sequence })
      await expect(log.readPage(oldRead.session, oldRead.cursor)).rejects.toBeInstanceOf(
        StaleCheckpointError,
      )
      await expect(log.append('first', bytes(5))).rejects.toBeInstanceOf(StaleCheckpointError)
      const snapshot = await log.beginRead()
      const later = await log.append('second', bytes(6))
      expect(later).toBeGreaterThan(sequence)
      expect((await log.readPage(snapshot.session, snapshot.cursor)).entries).toHaveLength(0)
    })
  })

  it('binds the cutoff to the freeze token and retries the same commit', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await log.initialize('first', bytes(1))
      await log.append('first', bytes(2))
      const cut = await log.freeze('first', 1)
      await expect(log.freeze('first', 1)).rejects.toBeInstanceOf(LogFrozenError)
      await expect(
        log.commit({ ...cut, cutoff: cut.cutoff + 1 }, 'second', bytes(3)),
      ).rejects.toBeInstanceOf(StaleCheckpointError)
      expect(await readAll(log)).toHaveLength(1)
      await log.commit(cut, 'second', bytes(3))
      await expect(log.commit(cut, 'second', bytes(3))).resolves.toBeUndefined()
      await expect(log.commit(cut, 'second', bytes(4))).rejects.toBeInstanceOf(StaleCheckpointError)
    })
  })

  it('rejects a stale page and preserves the log after abort', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await log.initialize('first', bytes(1))
      await log.append('first', bytes(2))
      const cut = await log.freeze('first', 1)
      await log.abort(cut)
      expect(await readAll(log)).toHaveLength(1)
      await expect(log.commit(cut, 'second', bytes(3))).rejects.toBeInstanceOf(StaleCheckpointError)
      const oldRead = await log.beginRead()
      const next = await log.freeze('first', 1)
      await log.commit(next, 'second', bytes(3))
      await expect(log.readPage(oldRead.session, oldRead.cursor)).rejects.toBeInstanceOf(
        StaleCheckpointError,
      )
    })
  })

  it('recovers a frozen cut after eviction and rejects a different initial checkpoint', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    const cut = await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await log.initialize('first', bytes(1))
      await log.initialize('first', bytes(1))
      await expect(log.initialize('first', bytes(2))).rejects.toBeInstanceOf(StaleCheckpointError)
      await log.append('first', bytes(2))
      return log.freeze('first', 1)
    })
    await evictDurableObject(stub)
    await runInDurableObject(stub, async (_: Room, state) => {
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      expect(log.pendingCut()).toEqual(cut)
      await log.abort(cut)
      expect(log.pendingCut()).toBeUndefined()
      expect(await readAll(log)).toHaveLength(1)
    })
  })

  it('rejects an epoch that was used before without deleting the log', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await log.initialize('first', bytes(1))
      const initial = await log.freeze('first', 1)
      await log.commit(initial, 'second', bytes(2))
      await log.append('second', bytes(3))
      const next = await log.freeze('second', 2)
      await expect(log.commit(next, 'first', bytes(4))).rejects.toBeInstanceOf(StaleCheckpointError)
      expect(await readAll(log)).toHaveLength(1)
      expect(log.pendingCut()).toEqual(next)
    })
  })

  it('rejects an append that was hashing when the host froze the log', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await log.initialize('first', bytes(1))
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
        const pending = log.append('first', bytes(2))
        const cut = await log.freeze('first', 1)
        resume()
        await expect(pending).rejects.toBeInstanceOf(LogFrozenError)
        expect(cut.cutoff).toBe(0)
        expect(await readAll(log)).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })
  })

  it('retries a commit after sync fails without applying it twice', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await log.initialize('first', bytes(1))
      await log.append('first', bytes(2))
      const cut = await log.freeze('first', 1)
      const spy = vi.spyOn(state.storage, 'sync').mockRejectedValueOnce(new Error('sync failed'))
      try {
        await expect(log.commit(cut, 'second', bytes(3))).rejects.toThrow('sync failed')
      } finally {
        spy.mockRestore()
      }
      await log.commit(cut, 'second', bytes(3))
      expect(log.checkpoint()).toMatchObject({ epoch: 'second', generation: 2, cutoff: cut.cutoff })
    })
  })

  it('retries an abort without releasing a newer freeze', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await log.initialize('first', bytes(1))
      const first = await log.freeze('first', 1)
      const spy = vi.spyOn(state.storage, 'sync').mockRejectedValueOnce(new Error('sync failed'))
      try {
        await expect(log.abort(first)).rejects.toThrow('sync failed')
      } finally {
        spy.mockRestore()
      }
      const second = await log.freeze('first', 1)
      await expect(log.abort(first)).resolves.toBeUndefined()
      expect(log.pendingCut()).toEqual(second)
    })
  })

  it('cannot restore a checkpoint when the room closes during sync', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(9))
      const log = new DurableLog(state.storage, { bytes: 100, frames: 10 })
      await log.initialize('first', bytes(1))
      const cut = await log.freeze('first', 1)
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
        const pending = log.commit(cut, 'second', bytes(3))
        await syncing
        DurableLog.clear(state.storage)
        resume()
        await expect(pending).rejects.toBeInstanceOf(LogClosedError)
        expect(
          state.storage.sql.exec('SELECT singleton FROM durable_checkpoint').toArray(),
        ).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })
  })

  it('cleans a log created before checkpoint tables existed', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
    await runInDurableObject(stub, (_: Room, state) => {
      state.storage.sql.exec(
        'CREATE TABLE durable_log (sequence INTEGER PRIMARY KEY, ciphertext BLOB)',
      )
      state.storage.sql.exec('CREATE TABLE durable_log_meta (closed INTEGER NOT NULL)')
      state.storage.sql.exec('INSERT INTO durable_log_meta (closed) VALUES (0)')
      state.storage.sql.exec(
        'INSERT INTO durable_log (sequence, ciphertext) VALUES (1, ?)',
        bytes(1),
      )
      DurableLog.clear(state.storage)
      expect(state.storage.sql.exec('SELECT sequence FROM durable_log').toArray()).toHaveLength(0)
      expect(
        state.storage.sql.exec<{ closed: number }>('SELECT closed FROM durable_log_meta').one()
          .closed,
      ).toBe(1)
    })
  })
})
