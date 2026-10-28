import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import worker from '../src/index.ts'
import { type KeptSweepShard, keptShardName } from '../src/kept-sweep-shard.ts'
import { KeptTransport } from '../src/kept-transport.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const registry = (env as Env & { KEPT_SWEEP: DurableObjectNamespace<KeptSweepShard> }).KEPT_SWEEP
const blob = 'blob000000000000000001'
async function scheduled() {
  const ctx = createExecutionContext()
  worker.scheduled({} as ScheduledController, env, ctx)
  await waitOnExecutionContext(ctx)
}

it('rediscovers a closed room and retires only after its encrypted attachment is deleted', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const room = env.ROOM.get(env.ROOM.idFromName(id)),
    roomId = room.id.toString()
  const transport = (state: DurableObjectState) =>
    new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
  await runInDurableObject(room, async (_, state) => {
    await transport(state).initialize(id, host, caps, 'epoch', Uint8Array.of(1).buffer)
  })
  const put = await room.fetch(`https://room/internal/kept/${id}/blobs/${blob}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${caps.editor}` },
    body: Uint8Array.of(3),
  })
  expect(put.status).toBe(204)
  const key = `kept/${roomId}/${blob}`
  const shard = registry.getByName(keptShardName(roomId))
  const entry = await shard.next()
  expect(entry?.id).toBe(roomId)
  await scheduled()
  expect(await env.BLOBS.head(key)).not.toBeNull()
  expect((await shard.next())?.id).toBe(roomId)
  await runInDurableObject(room, async (_, state) => {
    await transport(state).close(id, host)
  })
  // Do not run the room's alarm: the independent Worker must rediscover it.
  await scheduled()
  expect(await env.BLOBS.head(key)).toBeNull()
  expect(await shard.next()).toBeNull()
})

it('does not retire a new registration using an earlier sweep generation', async () => {
  const roomId = env.ROOM.idFromName(crypto.randomUUID()).toString()
  const shard = registry.getByName(keptShardName(roomId))
  await shard.register(roomId)
  const before = await shard.next()
  expect(before?.id).toBe(roomId)
  await shard.register(roomId)
  await shard.retire(roomId, before!.generation)
  const after = await shard.next()
  expect(after?.id).toBe(roomId)
  expect(after!.generation).toBeGreaterThan(before!.generation)
  await shard.retire(roomId, after!.generation)
  expect(await shard.next()).toBeNull()
})

it('retains an uncertain PUT for future sweeps even after R2 is empty', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const room = env.ROOM.get(env.ROOM.idFromName(id)),
    roomId = room.id.toString()
  const shard = registry.getByName(keptShardName(roomId))
  await shard.register(roomId)
  const transport = (state: DurableObjectState) =>
    new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
  await runInDurableObject(room, async (_, state) => {
    await transport(state).initialize(id, host, caps, 'epoch', Uint8Array.of(1).buffer)
    const actual = env.BLOBS
    const bucket = new Proxy(actual, {
      get(target, prop) {
        if (prop === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            await target.put(...args)
            throw new Error('unknown result')
          }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const { KeptBlobCleanup } = await import('../src/kept-blob-cleanup.ts')
    const cleanup = new KeptBlobCleanup(state, bucket, { count: 5, blobBytes: 95, quotaBytes: 100 })
    await expect(cleanup.put(blob, Uint8Array.of(9))).rejects.toThrow('unknown result')
    await transport(state).close(id, host)
  })
  await scheduled()
  expect(await env.BLOBS.head(`kept/${roomId}/${blob}`)).toBeNull()
  expect((await shard.next())?.id).toBe(roomId)
  await scheduled()
  expect((await shard.next())?.id).toBe(roomId)
})

it('removes a reserved-but-unsent upload when registry registration fails', async () => {
  const room = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
  await runInDurableObject(room, async (_, state) => {
    const { KeptBlobCleanup } = await import('../src/kept-blob-cleanup.ts')
    const cleanup = new KeptBlobCleanup(state, env.BLOBS, { count: 1, blobBytes: 8, quotaBytes: 8 })
    await expect(
      cleanup.put(blob, Uint8Array.of(1), async () => {
        throw new Error('registry full')
      }),
    ).rejects.toThrow('registry full')
    expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(0)
    expect(await env.BLOBS.head(`kept/${state.id.toString()}/${blob}`)).toBeNull()
  })
})

it('frees bounded capacity only after matching retirement', async () => {
  const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
  await runInDurableObject(stub, async (_, state) => {
    const { KeptSweepRegistry } = await import('../src/kept-sweep-registry.ts')
    const r = new KeptSweepRegistry(state.storage, 1)
    const first = '1'.repeat(64),
      second = '2'.repeat(64)
    await r.register(first)
    await expect(r.register(second)).rejects.toThrow('registry capacity reached')
    const selected = await r.next()
    expect(selected?.id).toBe(first)
    await r.retire(first, selected!.generation)
    await r.register(second)
    expect((await r.next())?.id).toBe(second)
  })
})

it('recovers after the room alarm fails to delete an expired room attachment', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const room = env.ROOM.get(env.ROOM.idFromName(id)),
    roomId = room.id.toString()
  const transport = (state: DurableObjectState) =>
    new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
  await runInDurableObject(room, async (_, state) => {
    await transport(state).initialize(id, host, caps, 'epoch', Uint8Array.of(1).buffer)
  })
  const put = await room.fetch(`https://room/internal/kept/${id}/blobs/${blob}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${caps.editor}` },
    body: Uint8Array.of(3),
  })
  expect(put.status).toBe(204)
  await runInDurableObject(room, async (instance, state) => {
    await transport(state).close(id, host)
    const original = instance['env']
    const bucket = new Proxy(original.BLOBS, {
      get(target, prop) {
        if (prop === 'delete')
          return async () => {
            throw new Error('injected R2 failure')
          }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    instance['env'] = { ...original, BLOBS: bucket }
    try {
      await expect(instance.alarm()).rejects.toThrow('injected R2 failure')
    } finally {
      instance['env'] = original
    }
  })
  expect(await env.BLOBS.head(`kept/${roomId}/${blob}`)).not.toBeNull()
  await scheduled()
  expect(await env.BLOBS.head(`kept/${roomId}/${blob}`)).toBeNull()
  expect(await registry.getByName(keptShardName(roomId)).next()).toBeNull()
})

it('continues to another room when delivery for one room times out', async () => {
  const first = env.ROOM.idFromName(crypto.randomUUID())
  let second: DurableObjectId
  do {
    second = env.ROOM.idFromName(crypto.randomUUID())
  } while (keptShardName(first.toString()) !== keptShardName(second.toString()))
  const ids = [first, second].sort((a, b) => a.toString().localeCompare(b.toString()))
  const stalled = ids[0]!.toString(),
    succeeds = ids[1]!.toString()
  const shard = registry.getByName(keptShardName(stalled))
  await shard.register(stalled)
  await shard.register(succeeds)
  let completed = 0
  const rooms = new Proxy(env.ROOM, {
    get(target, key) {
      if (key === 'get')
        return (id: DurableObjectId) => ({
          sweepKeptAttachments: async () => {
            if (id.toString() === stalled) await new Promise<void>(() => {})
            if (id.toString() === succeeds) completed++
            return true
          },
        })
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const { scheduledKeptSweep } = await import('../src/kept-scheduled.ts')
  await scheduledKeptSweep({ ...env, ROOM: rooms })
  expect(completed).toBe(1)
  const entry = await shard.next()
  expect(entry?.id).toBe(stalled)
})

it('safely retires a reservation whose registration was interrupted before any PUT', async () => {
  const room = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
  await runInDurableObject(room, async (_, state) => {
    const { KeptBlobCleanup } = await import('../src/kept-blob-cleanup.ts')
    const cleanup = new KeptBlobCleanup(state, env.BLOBS, { count: 1, blobBytes: 8, quotaBytes: 8 })
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = cleanup.put(blob, Uint8Array.of(1), async () => {
      enter()
      await gate
    })
    await entered
    await cleanup.close()
    expect(await cleanup.sweep()).toBe(true)
    release()
    await expect(pending).rejects.toThrow('closed')
    expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(0)
    expect(await env.BLOBS.head(`kept/${state.id.toString()}/${blob}`)).toBeNull()
  })
})

it('releases the upload slot if registry RPC never finishes', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  const transport = (state: DurableObjectState) =>
    new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
  await runInDurableObject(room, async (instance, state) => {
    await transport(state).initialize(id, host, caps, 'epoch', Uint8Array.of(1).buffer)
    const original = instance['env']
    let release!: () => void
    let registrations = 0
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const fake = {
      getByName: () => ({
        register: () => {
          registrations++
          return pending
        },
      }),
    }
    instance['env'] = { ...original, KEPT_SWEEP: fake } as unknown as Env
    const request = () =>
      new Request(`https://room/internal/kept/${id}/blobs/${blob}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${caps.editor}` },
        body: Uint8Array.of(3),
      })
    try {
      expect((await instance.fetch(request())).status).toBe(403)
      expect(state.storage.sql.exec('SELECT * FROM kept_blob_puts').toArray()).toHaveLength(0)
      expect((await instance.fetch(request())).status).toBe(403)
      expect(registrations).toBe(1)
    } finally {
      instance['env'] = original
    }
    release()
    await pending
    expect((await instance.fetch(request())).status).toBe(204)
  })
}, 5000)
