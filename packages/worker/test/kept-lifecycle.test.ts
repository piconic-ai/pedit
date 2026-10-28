import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { DurableLog } from '../src/durable-log.ts'
import { KeptTransport } from '../src/kept-transport.ts'
import type { Room } from '../src/room.ts'
import { roomIdFor } from '../src/room-identity.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

const bytes = (...x: number[]) => new Uint8Array(x).buffer
const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const capabilities = () => ({ editor: token(), commenter: token(), reader: token() })
const policy = { requestedSeconds: 100, roomMaxSeconds: 120, maxKeepSeconds: 80, alarmSeconds: 60 }
async function room() {
  const host = token(),
    id = await roomIdFor(host)
  return { id, host, stub: env.ROOM.get(env.ROOM.idFromName(id)) }
}

describe('kept lifecycle integration', () => {
  it('persists cap, host departures, reconnect and expiry across eviction', async () => {
    const r = await room(),
      c = capabilities()
    let now = Date.now() + 300_000
    const initial = now
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await expect(t.initialize(r.id, token(), c, 'one', bytes(0))).rejects.toThrow()
      expect(state.storage.kv.get('keptLifetime')).toBeUndefined()
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      await t.append(c.editor, 'one', bytes(1))
      await expect(t.leave(r.id, c.reader)).rejects.toThrow('invalid host credentials')
      now += 100_000
      const left = await t.leave(r.id, r.host)
      expect(left.host).toBe('away')
      if (left.host !== 'away') throw new Error('expected away')
      expect(left.keepSeconds).toBe(80)
      expect((await t.status(r.id, r.host)).host).toBe('away')
      await expect(t.status(r.id, c.reader)).rejects.toThrow('invalid host credentials')
      expect(left.keepUntil).toBe(initial + 180_000)
      expect(left.totalUntil).toBe(left.keepUntil)
      expect(await state.storage.getAlarm()).not.toBeNull()
    })
    await evictDurableObject(r.stub)
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      const snapshot = await t.beginRead(c.reader)
      const page = await t.readPage(c.reader, snapshot.session, snapshot.cursor)
      expect(page.entries.map((e) => [...new Uint8Array(e.ciphertext)])).toEqual([[1]])
      now += 10_000
      expect((await t.resume(r.id, r.host)).host).toBe('connected')
      now += 10_000
      const left = await t.leave(r.id, r.host)
      if (left.host !== 'away') throw new Error('expected away')
      expect(left.keepUntil).toBe(initial + 200_000)
      now = left.keepUntil
      await expect(t.append(c.editor, 'one', bytes(2))).rejects.toThrow()
      expect((await t.alarm()).host).toBe('closed')
      expect(state.storage.kv.get(ADMISSION_KEY)).toBeUndefined()
      expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toEqual([])
      await expect(t.initialize(r.id, r.host, c, 'one', bytes(0))).rejects.toThrow()
    })
  })

  it('does not acknowledge or retain a frame when expiry wins during hash', async () => {
    const r = await room(),
      c = capabilities()
    let now = Date.now() + 300_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      const left = await t.leave(r.id, r.host)
      if (left.host !== 'away') throw new Error('expected away')
      let resume!: () => void, entered!: () => void
      const wait = new Promise<void>((resolve) => {
        resume = resolve
      })
      const hashing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const hash = crypto.subtle.digest.bind(crypto.subtle)
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, input) => {
        const view =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        if (view.length === 1 && view[0] === 7) {
          entered()
          await wait
        }
        return hash(algorithm, input)
      })
      try {
        const pending = t.append(c.editor, 'one', bytes(7))
        await hashing
        now = left.keepUntil
        expect((await t.alarm()).host).toBe('closed')
        resume()
        await expect(pending).rejects.toThrow()
        expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toEqual([])
      } finally {
        resume()
        spy.mockRestore()
      }
    })
  })

  it('rejects an append when expiry clears it during storage sync', async () => {
    const r = await room(),
      c = capabilities()
    let now = Date.now() + 300_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      const left = await t.leave(r.id, r.host)
      if (left.host !== 'away') throw new Error('expected away')
      let resume!: () => void
      let entered!: () => void
      const wait = new Promise<void>((resolve) => {
        resume = resolve
      })
      const syncing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const sync = state.storage.sync.bind(state.storage)
      let stopped = false
      const spy = vi.spyOn(state.storage, 'sync').mockImplementation(async () => {
        const count = state.storage.sql
          .exec<{ count: number }>('SELECT count(*) AS count FROM durable_log')
          .one().count
        if (count > 0 && !stopped) {
          stopped = true
          entered()
          await wait
        }
        await sync()
      })
      try {
        const pending = t.append(c.editor, 'one', bytes(7))
        await syncing
        now = left.keepUntil
        expect((await t.alarm()).host).toBe('closed')
        resume()
        await expect(pending).rejects.toThrow()
        expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toEqual([])
      } finally {
        resume()
        spy.mockRestore()
      }
    })
  })

  it('preserves a concurrent departure when an append was waiting to hash', async () => {
    const r = await room(),
      c = capabilities()
    let now = Date.now() + 300_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      const other = new KeptTransport(
        state,
        env.ROOM,
        { bytes: 100, frames: 10 },
        policy,
        () => now,
      )
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      let resume!: () => void, entered!: () => void
      const waiting = new Promise<void>((resolve) => {
        resume = resolve
      })
      const hashing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const hash = crypto.subtle.digest.bind(crypto.subtle)
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, input) => {
        const view =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        if (view.length === 1 && view[0] === 7) {
          entered()
          await waiting
        }
        return hash(algorithm, input)
      })
      try {
        const pending = t.append(c.editor, 'one', bytes(7))
        await hashing
        now += 1000
        expect((await other.leave(r.id, r.host)).host).toBe('away')
        resume()
        await expect(pending).resolves.toBe(1)
        expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('away')
        const snapshot = await t.beginRead(c.reader)
        expect(
          (await t.readPage(c.reader, snapshot.session, snapshot.cursor)).entries,
        ).toHaveLength(1)
      } finally {
        resume()
        spy.mockRestore()
      }
    })
  })

  it('does not lose a departure when append races its alarm transaction', async () => {
    const r = await room(),
      c = capabilities()
    let now = Date.now() + 300_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const a = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      const b = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await a.initialize(r.id, r.host, c, 'one', bytes(0))
      let resume!: () => void, entered!: () => void
      const wait = new Promise<void>((resolve) => {
        resume = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      const getAlarm = state.storage.getAlarm.bind(state.storage)
      let paused = false
      const spy = vi.spyOn(state.storage, 'getAlarm').mockImplementation(async () => {
        if (!paused) {
          paused = true
          entered()
          await wait
        }
        return getAlarm()
      })
      try {
        now += 1000
        const leave = a.leave(r.id, r.host)
        await waiting
        const append = b.append(c.editor, 'one', bytes(1))
        resume()
        const results = await Promise.allSettled([leave, append])
        const stateNow = state.storage.kv.get<{ host: string }>('keptLifetime')
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
        expect(stateNow?.host).toBe('away')
      } finally {
        resume()
        spy.mockRestore()
      }
    })
  })

  it('only allows the host to close and preserves the closed tombstone', async () => {
    const r = await room(),
      c = capabilities()
    const now = Date.now() + 300_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      await t.append(c.editor, 'one', bytes(1))
      await expect(t.close(r.id, c.editor)).rejects.toThrow('invalid host credentials')
      expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toHaveLength(1)
      expect((await t.close(r.id, r.host)).host).toBe('closed')
      expect((await t.alarm()).host).toBe('closed')
      await expect(t.resume(r.id, r.host)).rejects.toThrow()
      expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toEqual([])
    })
  })

  it('does not report a kept deadline after close wins during departure sync', async () => {
    const r = await room(),
      c = capabilities()
    const now = Date.now() + 300_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      let resume!: () => void
      let entered!: () => void
      const wait = new Promise<void>((resolve) => {
        resume = resolve
      })
      const syncing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const sync = state.storage.sync.bind(state.storage)
      let stopped = false
      const spy = vi.spyOn(state.storage, 'sync').mockImplementation(async () => {
        const current = state.storage.kv.get<{ host: string }>('keptLifetime')
        if (current?.host === 'away' && !stopped) {
          stopped = true
          entered()
          await wait
        }
        await sync()
      })
      try {
        const pending = t.leave(r.id, r.host)
        await syncing
        expect((await t.close(r.id, r.host)).host).toBe('closed')
        resume()
        await expect(pending).rejects.toThrow('kept lifetime changed')
        expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('closed')
      } finally {
        resume()
        spy.mockRestore()
      }
    })
  })

  it('rejects clock rollback between append transaction and sync', async () => {
    const r = await room(),
      c = capabilities()
    const initial = Date.now() + 300_000
    let now = initial
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      let resumeHash!: () => void, hashEntered!: () => void
      let resumeSync!: () => void, syncEntered!: () => void
      const hashWait = new Promise<void>((resolve) => {
        resumeHash = resolve
      })
      const hashing = new Promise<void>((resolve) => {
        hashEntered = resolve
      })
      const syncWait = new Promise<void>((resolve) => {
        resumeSync = resolve
      })
      const syncing = new Promise<void>((resolve) => {
        syncEntered = resolve
      })
      const hash = crypto.subtle.digest.bind(crypto.subtle)
      const hashSpy = vi
        .spyOn(crypto.subtle, 'digest')
        .mockImplementation(async (algorithm, input) => {
          const view =
            input instanceof ArrayBuffer
              ? new Uint8Array(input)
              : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          if (view.length === 1 && view[0] === 7) {
            hashEntered()
            await hashWait
          }
          return hash(algorithm, input)
        })
      const sync = state.storage.sync.bind(state.storage)
      let stopped = false
      const syncSpy = vi.spyOn(state.storage, 'sync').mockImplementation(async () => {
        const count = state.storage.sql
          .exec<{ count: number }>('SELECT count(*) AS count FROM durable_log')
          .one().count
        if (count && !stopped) {
          stopped = true
          syncEntered()
          await syncWait
        }
        await sync()
      })
      try {
        const pending = t.append(c.editor, 'one', bytes(7))
        await hashing
        now = initial + 10_000
        resumeHash()
        await syncing
        now = initial + 5_000
        resumeSync()
        await expect(pending).rejects.toThrow('clock moved backwards')
        await expect(t.beginRead(c.reader)).rejects.toThrow('clock moved backwards')
        now = initial + 10_000
        const sequence = await t.append(c.editor, 'one', bytes(7))
        const snapshot = await t.beginRead(c.reader)
        const page = await t.readPage(c.reader, snapshot.session, snapshot.cursor)
        expect(page.entries.map((entry) => entry.sequence)).toEqual([sequence])
      } finally {
        resumeHash()
        resumeSync()
        hashSpy.mockRestore()
        syncSpy.mockRestore()
      }
    })
  })

  it('retains clock observations when a quota failure rolls back an append', async () => {
    const r = await room(),
      c = capabilities()
    const initial = Date.now() + 300_000
    let now = initial
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 1 }, policy, () => now)
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      await t.append(c.editor, 'one', bytes(1))
      let resume!: () => void, entered!: () => void
      const wait = new Promise<void>((resolve) => {
        resume = resolve
      })
      const hashing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const hash = crypto.subtle.digest.bind(crypto.subtle)
      const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, input) => {
        const view =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        if (view.length === 1 && view[0] === 7) {
          entered()
          await wait
        }
        return hash(algorithm, input)
      })
      try {
        const pending = t.append(c.editor, 'one', bytes(7))
        await hashing
        now = initial + 10_000
        resume()
        await expect(pending).rejects.toThrow()
      } finally {
        resume()
        spy.mockRestore()
      }
    })
    await evictDurableObject(r.stub)
    now = initial + 5_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const recovered = new KeptTransport(
        state,
        env.ROOM,
        { bytes: 100, frames: 1 },
        policy,
        () => now,
      )
      await expect(recovered.beginRead(c.reader)).rejects.toThrow('clock moved backwards')
      now = initial + 10_000
      await expect(recovered.beginRead(c.reader)).resolves.toBeDefined()
    })
  })

  it('keeps a failed departure observation visible to other instances', async () => {
    const r = await room(),
      c = capabilities()
    const initial = Date.now() + 300_000
    let now = initial
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const a = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      const b = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await a.initialize(r.id, r.host, c, 'one', bytes(0))
      await a.leave(r.id, r.host)
      now = initial + 10_000
      await expect(a.leave(r.id, r.host)).rejects.toThrow('host is already away')
      now = initial + 5_000
      await expect(b.resume(r.id, r.host)).rejects.toThrow('clock moved backwards')
      now = initial + 10_000
      expect((await b.resume(r.id, r.host)).host).toBe('connected')
    })
  })

  it('blocks another instance while a failed departure observation is syncing', async () => {
    const r = await room(),
      c = capabilities()
    const initial = Date.now() + 300_000
    let now = initial
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const a = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      const b = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await a.initialize(r.id, r.host, c, 'one', bytes(0))
      await a.leave(r.id, r.host)
      let resume!: () => void, entered!: () => void
      const wait = new Promise<void>((resolve) => {
        resume = resolve
      })
      const syncing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const sync = state.storage.sync.bind(state.storage)
      let stopped = false
      const spy = vi.spyOn(state.storage, 'sync').mockImplementation(async () => {
        if (!stopped) {
          stopped = true
          entered()
          await wait
        }
        await sync()
      })
      try {
        now = initial + 10_000
        const pending = a.leave(r.id, r.host)
        await syncing
        now = initial + 5_000
        await expect(b.resume(r.id, r.host)).rejects.toThrow('clock moved backwards')
        resume()
        await expect(pending).rejects.toThrow('host is already away')
      } finally {
        resume()
        spy.mockRestore()
      }
    })
  })

  it('keeps the closed tombstone when log cleanup fails and retries on alarm', async () => {
    const r = await room(),
      c = capabilities()
    let now = Date.now() + 300_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      await t.append(c.editor, 'one', bytes(1))
      const left = await t.leave(r.id, r.host)
      if (left.host !== 'away') throw new Error('expected away')
      now = left.keepUntil
      const spy = vi.spyOn(DurableLog, 'clear').mockImplementationOnce(() => {
        throw new Error('cleanup failed')
      })
      try {
        await expect(t.alarm()).rejects.toThrow('cleanup failed')
      } finally {
        spy.mockRestore()
      }
      expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('closed')
      expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toHaveLength(1)
      expect((await t.alarm()).host).toBe('closed')
      expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toHaveLength(0)
      expect(state.storage.kv.get(ADMISSION_KEY)).toBeUndefined()
    })
  })

  it('rolls back lifetime and alarm when scheduling fails', async () => {
    const r = await room(),
      c = capabilities()
    const now = Date.now() + 300_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy, () => now)
      const spy = vi
        .spyOn(state.storage, 'setAlarm')
        .mockRejectedValueOnce(new Error('alarm failed'))
      try {
        await expect(t.initialize(r.id, r.host, c, 'one', bytes(0))).rejects.toThrow('alarm failed')
      } finally {
        spy.mockRestore()
      }
      expect(state.storage.kv.get('keptLifetime')).toBeUndefined()
      expect(await state.storage.getAlarm()).toBeNull()
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      expect(await state.storage.getAlarm()).not.toBeNull()
    })
  })

  it('closes for maintenance and refuses old credentials after close', async () => {
    const r = await room(),
      c = capabilities()
    let maintenance = false
    const now = Date.now() + 300_000
    await runInDurableObject(r.stub, async (_: Room, state) => {
      const t = new KeptTransport(
        state,
        env.ROOM,
        { bytes: 100, frames: 10 },
        policy,
        () => now,
        () => maintenance,
      )
      await t.initialize(r.id, r.host, c, 'one', bytes(0))
      await t.append(c.editor, 'one', bytes(1))
      maintenance = true
      await expect(t.append(c.commenter, 'one', bytes(2))).rejects.toThrow()
      expect(state.storage.kv.get(ADMISSION_KEY)).toBeUndefined()
      expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toEqual([])
      maintenance = false
      await expect(t.initialize(r.id, r.host, c, 'one', bytes(0))).rejects.toThrow()
    })
  })
})

it('does not allow another transport to observe a regressed clock while preserving a failed append observation', async () => {
  const r = await room(),
    c = capabilities(),
    initial = Date.now() + 300_000
  let now = initial
  await runInDurableObject(r.stub, async (_: Room, state) => {
    const a = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 1 }, policy, () => now)
    const b = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 1 }, policy, () => now)
    await a.initialize(r.id, r.host, c, 'one', bytes(0))
    await a.append(c.editor, 'one', bytes(1))
    let resumeHash!: () => void,
      hashEntered!: () => void,
      resumeRemember!: () => void,
      rememberEntered!: () => void
    const hashWait = new Promise<void>((r) => {
        resumeHash = r
      }),
      hashing = new Promise<void>((r) => {
        hashEntered = r
      })
    const rememberWait = new Promise<void>((r) => {
        resumeRemember = r
      }),
      remembering = new Promise<void>((r) => {
        rememberEntered = r
      })
    const hash = crypto.subtle.digest.bind(crypto.subtle)
    const hashSpy = vi
      .spyOn(crypto.subtle, 'digest')
      .mockImplementation(async (algorithm, input) => {
        const view =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        if (view.length === 1 && view[0] === 7) {
          hashEntered()
          await hashWait
        }
        return hash(algorithm, input)
      })
    const transaction = state.storage.transaction.bind(state.storage)
    let pauseNext = false
    const transactionSpy = vi
      .spyOn(state.storage, 'transaction')
      .mockImplementation(async (callback) => {
        if (pauseNext) {
          pauseNext = false
          rememberEntered()
          await rememberWait
        }
        return transaction(callback)
      })
    try {
      const pending = a.append(c.editor, 'one', bytes(7))
      await hashing
      now = initial + 10_000
      pauseNext = true
      resumeHash()
      await remembering
      now = initial + 5_000
      await expect(b.leave(r.id, r.host)).rejects.toThrow('clock moved backwards')
      expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('connected')
      resumeRemember()
      await expect(pending).rejects.toThrow()
    } finally {
      resumeHash()
      resumeRemember()
      hashSpy.mockRestore()
      transactionSpy.mockRestore()
    }
  })
})
