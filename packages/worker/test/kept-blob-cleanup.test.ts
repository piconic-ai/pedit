import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { KeptBlobCleanup } from '../src/kept-blob-cleanup.ts'
import type { Room } from '../src/room.ts'

const id = (n: number) => `blob${String(n).padStart(18, '0')}`
const limits = { count: 3, blobBytes: 8, quotaBytes: 10 }
const room = () => env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
const prefix = (state: DurableObjectState) => `kept/${state.id.toString()}/`
const gate = () => {
  let enter!: () => void, release!: () => void
  return {
    entered: new Promise<void>((r) => {
      enter = r
    }),
    wait: new Promise<void>((r) => {
      release = r
    }),
    enter: () => enter(),
    release: () => release(),
  }
}
function proxy(bucket: R2Bucket, overrides: Partial<R2Bucket>): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property in overrides) return Reflect.get(overrides, property)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

describe('kept attachment cleanup primitive', () => {
  it('deletes only kept objects after close and cannot reopen', async () => {
    const stub = room()
    await runInDurableObject(stub, async (_: Room, state) => {
      const x = new KeptBlobCleanup(state, env.BLOBS, limits)
      await x.put(id(1), Uint8Array.of(1))
      const old = `rooms/${state.id.toString()}/${id(1)}`
      await env.BLOBS.put(old, 'v5')
      await expect(x.sweep()).rejects.toThrow('open')
      await x.close()
      expect(await state.storage.getAlarm()).not.toBeNull()
      expect(await x.sweep()).toBe(true)
      expect(await env.BLOBS.head(prefix(state) + id(1))).toBeNull()
      expect(await env.BLOBS.head(old)).not.toBeNull()
      await expect(x.put(id(2), Uint8Array.of(2))).rejects.toThrow('closed')
    })
  })

  it('sweeps every page without touching another prefix', async () => {
    const stub = room()
    await runInDurableObject(stub, async (_: Room, state) => {
      const x = new KeptBlobCleanup(state, env.BLOBS, limits)
      const p = prefix(state)
      for (let i = 0; i < 1020; i++) await env.BLOBS.put(p + id(i), 'x')
      const other = `kept/${state.id.toString()}other/${id(1)}`
      await env.BLOBS.put(other, 'x')
      await x.close()
      expect(await x.sweep()).toBe(true)
      expect((await env.BLOBS.list({ prefix: p })).objects).toHaveLength(0)
      expect(await env.BLOBS.head(other)).not.toBeNull()
    })
  })

  it('keeps an unresolved upload until its late completion is swept', async () => {
    const stub = room(),
      delayed = gate()
    await runInDurableObject(stub, async (_: Room, state) => {
      const bucket = proxy(env.BLOBS, {
        put: async (...args: Parameters<R2Bucket['put']>) => {
          delayed.enter()
          await delayed.wait
          return env.BLOBS.put(...args)
        },
      })
      const x = new KeptBlobCleanup(state, bucket, limits)
      const upload = x.put(id(1), Uint8Array.of(1))
      await delayed.entered
      await x.close()
      expect(await x.sweep()).toBe(false)
      expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(1)
      delayed.release()
      await expect(upload).rejects.toThrow('closed')
      expect(await env.BLOBS.head(prefix(state) + id(1))).not.toBeNull()
      expect(await x.sweep()).toBe(true)
      expect(await env.BLOBS.head(prefix(state) + id(1))).toBeNull()
    })
  })

  it('continues sweeping an ambiguous PUT across eviction', async () => {
    const stub = room()
    const p = await runInDurableObject(stub, async (_: Room, state) => {
      const bucket = proxy(env.BLOBS, {
        put: async () => {
          throw new Error('ambiguous PUT')
        },
      })
      const x = new KeptBlobCleanup(state, bucket, limits)
      await expect(x.put(id(1), Uint8Array.of(1))).rejects.toThrow('ambiguous PUT')
      await x.close()
      expect(await x.sweep()).toBe(false)
      return prefix(state)
    })
    await evictDurableObject(stub)
    await env.BLOBS.put(p + id(1), 'late')
    await runInDurableObject(stub, async (_: Room, state) => {
      const x = new KeptBlobCleanup(state, env.BLOBS, limits)
      expect(await x.sweep()).toBe(false)
      expect(await env.BLOBS.head(p + id(1))).toBeNull()
      expect(await state.storage.getAlarm()).not.toBeNull()
      await env.BLOBS.put(p + id(1), 'later')
      expect(await x.sweep()).toBe(false)
      expect(await env.BLOBS.head(p + id(1))).toBeNull()
      expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(1)
    })
  })

  it('reserves total quota and unique ids before each PUT', async () => {
    const stub = room()
    await runInDurableObject(stub, async (_: Room, state) => {
      const x = new KeptBlobCleanup(state, env.BLOBS, limits)
      await x.put(id(1), new Uint8Array(8))
      await expect(x.put(id(1), Uint8Array.of(2))).rejects.toThrow()
      await expect(x.put(id(2), new Uint8Array(3))).rejects.toThrow('capacity')
      await x.put(id(2), new Uint8Array(2))
      await expect(x.put(id(3), Uint8Array.of(1))).rejects.toThrow('capacity')
      await expect(x.put('bad', Uint8Array.of(1))).rejects.toThrow()
      await x.close()
      expect(await x.sweep()).toBe(true)
    })
  })

  it('rolls back close when its retry alarm cannot be saved', async () => {
    const stub = room()
    await runInDurableObject(stub, async (_: Room, state) => {
      const x = new KeptBlobCleanup(state, env.BLOBS, limits)
      const spy = vi
        .spyOn(state.storage, 'setAlarm')
        .mockRejectedValueOnce(new Error('alarm failed'))
      try {
        await expect(x.close()).rejects.toThrow('alarm failed')
      } finally {
        spy.mockRestore()
      }
      await x.put(id(1), Uint8Array.of(1))
      await x.close()
      expect(await x.sweep()).toBe(true)
    })
  })

  it('does not start a PUT when close wins while its reservation syncs', async () => {
    const stub = room(),
      syncGate = gate()
    await runInDurableObject(stub, async (_: Room, state) => {
      const x = new KeptBlobCleanup(state, env.BLOBS, limits)
      const sync = state.storage.sync.bind(state.storage)
      let paused = false
      const spy = vi.spyOn(state.storage, 'sync').mockImplementation(async () => {
        if (!paused) {
          paused = true
          syncGate.enter()
          await syncGate.wait
        }
        await sync()
      })
      try {
        const pending = x.put(id(1), Uint8Array.of(1))
        await syncGate.entered
        await x.close()
        syncGate.release()
        await expect(pending).rejects.toThrow('closed')
        expect(await x.sweep()).toBe(true)
        expect(await env.BLOBS.head(prefix(state) + id(1))).toBeNull()
      } finally {
        syncGate.release()
        spy.mockRestore()
      }
    })
  })

  it('keeps the retry alarm after list or delete failure', async () => {
    for (const failed of ['list', 'delete'] as const) {
      const stub = room()
      await runInDurableObject(stub, async (_: Room, state) => {
        let failing = true
        const bucket = proxy(env.BLOBS, {
          [failed]: async (...args: never[]) => {
            if (failing) throw new Error('R2 failed')
            return Reflect.apply(env.BLOBS[failed], env.BLOBS, args)
          },
        })
        const x = new KeptBlobCleanup(state, bucket, limits)
        await x.put(id(1), Uint8Array.of(1))
        await x.close()
        await expect(x.sweep()).rejects.toThrow('R2 failed')
        expect(await state.storage.getAlarm()).not.toBeNull()
        expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(1)
        failing = false
        expect(await x.sweep()).toBe(true)
        expect(await env.BLOBS.head(prefix(state) + id(1))).toBeNull()
      })
    }
  })

  it('counts an ambiguous PUT against capacity without discarding its reservation', async () => {
    const stub = room()
    await runInDurableObject(stub, async (_: Room, state) => {
      const bucket = proxy(env.BLOBS, {
        put: async () => {
          throw new Error('ambiguous')
        },
      })
      const x = new KeptBlobCleanup(state, bucket, {
        count: 1,
        blobBytes: 8,
        quotaBytes: 8,
      })
      await expect(x.put(id(1), Uint8Array.of(1))).rejects.toThrow('ambiguous')
      await expect(x.put(id(2), Uint8Array.of(1))).rejects.toThrow('capacity')
      expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(1)
      await x.close()
      expect(await x.sweep()).toBe(false)
    })
  })

  it('keeps a completion that happens after the sweep snapshots reservations', async () => {
    const stub = room(),
      upload = gate(),
      listing = gate()
    await runInDurableObject(stub, async (_: Room, state) => {
      const bucket = proxy(env.BLOBS, {
        put: async (...args: Parameters<R2Bucket['put']>) => {
          upload.enter()
          await upload.wait
          return env.BLOBS.put(...args)
        },
        list: async (...args: Parameters<R2Bucket['list']>) => {
          const page = await env.BLOBS.list(...args)
          listing.enter()
          await listing.wait
          return page
        },
      })
      const x = new KeptBlobCleanup(state, bucket, limits)
      const pending = x.put(id(1), Uint8Array.of(1))
      await upload.entered
      await x.close()
      const scan = x.sweep()
      await listing.entered
      upload.release()
      await expect(pending).rejects.toThrow('closed')
      listing.release()
      expect(await scan).toBe(false)
      expect(await x.sweep()).toBe(true)
      expect(await env.BLOBS.head(prefix(state) + id(1))).toBeNull()
    })
  })
})
