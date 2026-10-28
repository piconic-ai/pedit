import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import {
  DurableLog,
  LogClosedError,
  ReadSessionFullError,
  StaleCheckpointError,
} from '../src/durable-log.ts'
import type { Room } from '../src/room.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

const bytes = (n: number) => Uint8Array.of(n).buffer
const limits = { bytes: 1000, frames: 100 }
const room = () => env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))

describe('durable read sessions', () => {
  it('pins the tail, rejects a guessed cursor, and retries the last page across eviction', async () => {
    const stub = room()
    const session = await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(1))
      const log = new DurableLog(state.storage, limits)
      await log.initialize('one', bytes(0))
      for (let n = 1; n <= 17; n++) await log.append('one', bytes(n))
      const read = await log.beginRead()
      expect(read.tail).toBe(17)
      await log.append('one', bytes(18))
      await expect(log.readPage(read.session, crypto.randomUUID())).rejects.toBeInstanceOf(
        StaleCheckpointError,
      )
      const first = await log.readPage(read.session, read.cursor)
      expect(first.entries).toHaveLength(16)
      expect(first.next).not.toBeNull()
      expect(await log.readPage(read.session, read.cursor)).toEqual(first)
      return { ...read, next: first.next! }
    })
    await evictDurableObject(stub)
    await runInDurableObject(stub, async (_: Room, state) => {
      const log = new DurableLog(state.storage, limits)
      expect((await log.readPage(session.session, session.cursor)).entries).toHaveLength(16)
      const last = await log.readPage(session.session, session.next)
      expect(last.entries.map((e) => [...new Uint8Array(e.ciphertext)])).toEqual([[17]])
      expect(last.next).toBeNull()
      expect(await log.readPage(session.session, session.next)).toEqual(last)
      await expect(log.readPage(session.session, session.cursor)).rejects.toBeInstanceOf(
        StaleCheckpointError,
      )
    })
  })

  it('rejects a session after cutover and after close', async () => {
    const stub = room()
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(1))
      const log = new DurableLog(state.storage, limits)
      await log.initialize('one', bytes(0))
      const read = await log.beginRead()
      const cut = await log.freeze('one', 1)
      await log.commit(cut, 'two', bytes(1))
      await expect(log.readPage(read.session, read.cursor)).rejects.toBeInstanceOf(
        StaleCheckpointError,
      )
      const next = await log.beginRead()
      DurableLog.clear(state.storage)
      await expect(log.readPage(next.session, next.cursor)).rejects.toBeInstanceOf(LogClosedError)
      expect(state.storage.sql.exec('SELECT * FROM durable_reads').toArray()).toHaveLength(0)
    })
  })

  it('refuses a page when cutover occurs during its storage sync', async () => {
    const stub = room()
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(1))
      const log = new DurableLog(state.storage, limits)
      await log.initialize('one', bytes(0))
      await log.append('one', bytes(1))
      const read = await log.beginRead()
      let resume!: () => void
      let started!: () => void
      const waiting = new Promise<void>((resolve) => {
        resume = resolve
      })
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const actual = state.storage.sync.bind(state.storage)
      const spy = vi.spyOn(state.storage, 'sync').mockImplementationOnce(async () => {
        started()
        await waiting
        await actual()
      })
      try {
        const page = log.readPage(read.session, read.cursor)
        await entered
        const cut = await log.freeze('one', 1)
        await log.commit(cut, 'two', bytes(2))
        resume()
        await expect(page).rejects.toBeInstanceOf(StaleCheckpointError)
      } finally {
        spy.mockRestore()
      }
    })
  })

  it('refuses a new session if the checkpoint changes during sync', async () => {
    const stub = room()
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(1))
      const log = new DurableLog(state.storage, limits)
      await log.initialize('one', bytes(0))
      let resume!: () => void
      let started!: () => void
      const waiting = new Promise<void>((resolve) => {
        resume = resolve
      })
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const actual = state.storage.sync.bind(state.storage)
      const spy = vi.spyOn(state.storage, 'sync').mockImplementationOnce(async () => {
        started()
        await waiting
        await actual()
      })
      try {
        const read = log.beginRead()
        await entered
        const cut = await log.freeze('one', 1)
        await log.commit(cut, 'two', bytes(2))
        resume()
        await expect(read).rejects.toBeInstanceOf(StaleCheckpointError)
      } finally {
        spy.mockRestore()
      }
    })
  })

  it('bounds sessions and reclaims expired entries', async () => {
    const stub = room()
    await runInDurableObject(stub, async (_: Room, state) => {
      state.storage.kv.put(ADMISSION_KEY, bytes(1))
      const log = new DurableLog(state.storage, limits)
      await log.initialize('one', bytes(0))
      const reads = []
      for (let i = 0; i < 64; i++) reads.push(await log.beginRead())
      await expect(log.beginRead()).rejects.toBeInstanceOf(ReadSessionFullError)
      state.storage.sql.exec('UPDATE durable_reads SET expires = 0 WHERE id = ?', reads[0]!.session)
      await expect(log.readPage(reads[0]!.session, reads[0]!.cursor)).rejects.toBeInstanceOf(
        StaleCheckpointError,
      )
      await expect(log.beginRead()).resolves.toBeDefined()
    })
  })
})
