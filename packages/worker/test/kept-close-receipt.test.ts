import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { CLOSE_RECEIPT_KEY } from '../src/kept-lifecycle.ts'
import { KeptTransport } from '../src/kept-transport.ts'
import type { Room } from '../src/room.ts'
import { roomIdFor } from '../src/room-identity.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
async function setup() {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(room, async (_: Room, state) => {
    await new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    ).initializeAway(id, host, caps, 'epoch', Uint8Array.of(1).buffer)
  })
  return { host, id, caps, room }
}

it('retries a host-authenticated close after a lost response and eviction', async () => {
  const r = await setup()
  await runInDurableObject(r.room, async (instance: Room) => {
    await expect(instance.closeRetainedInternal(r.id, r.caps.editor)).rejects.toThrow()
    await expect(instance.closeRetainedInternal(await roomIdFor(token()), r.host)).rejects.toThrow()
    expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
      state: 'closed',
      cleanup: 'untracked',
    })
  })
  await evictDurableObject(r.room)
  await runInDurableObject(r.room, async (instance: Room) => {
    expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
      state: 'closed',
      cleanup: 'untracked',
    })
    await expect(instance.closeRetainedInternal(r.id, token())).rejects.toThrow()
  })
  const publicRetry = await r.room.fetch(`https://room/internal/kept/${r.id}/close`, {
    method: 'POST',
    headers: { Authorization: `Host ${r.host}` },
  })
  expect(publicRetry.status).toBe(403)
})

it('reports cleanup pending until an uncertain attachment upload is resolved', async () => {
  const r = await setup(),
    blob = 'blob000000000000000001'
  const put = await r.room.fetch(`https://room/internal/kept/${r.id}/blobs/${blob}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${r.caps.editor}` },
    body: Uint8Array.of(7),
  })
  expect(put.status).toBe(204)
  await runInDurableObject(r.room, async (instance: Room, state) => {
    state.storage.sql.exec('UPDATE kept_blob_puts SET completed = 0 WHERE id = ?', blob)
    expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
      state: 'closed',
      cleanup: 'pending',
    })
    expect(await state.storage.getAlarm()).not.toBeNull()
  })
  await evictDurableObject(r.room)
  await runInDurableObject(r.room, async (instance: Room, state) => {
    expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
      state: 'closed',
      cleanup: 'pending',
    })
    state.storage.sql.exec('UPDATE kept_blob_puts SET completed = 1 WHERE id = ?', blob)
    expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
      state: 'closed',
      cleanup: 'complete',
    })
  })
})

it('does not report closure after a receipt sync failure and can reconcile it', async () => {
  const r = await setup()
  await runInDurableObject(r.room, async (instance: Room, state) => {
    const sync = state.storage.sync.bind(state.storage)
    let failed = false
    const spy = vi.spyOn(state.storage, 'sync').mockImplementation(async () => {
      if (state.storage.kv.get(CLOSE_RECEIPT_KEY) !== undefined && !failed) {
        failed = true
        throw new Error('sync failed')
      }
      await sync()
    })
    try {
      await expect(instance.closeRetainedInternal(r.id, r.host)).rejects.toThrow('sync failed')
    } finally {
      spy.mockRestore()
    }
    expect(failed).toBe(true)
  })
  await evictDurableObject(r.room)
  await runInDurableObject(r.room, async (instance: Room) => {
    expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
      state: 'closed',
      cleanup: 'untracked',
    })
  })
})

it('does not interpret an existing v5 or uninitialized room as a retained close', async () => {
  const host = token(),
    id = await roomIdFor(host),
    room = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(room, async (instance: Room, state) => {
    state.storage.kv.put('openedAt', Date.now())
    state.storage.kv.put(ADMISSION_KEY, Uint8Array.of(9).buffer)
    await expect(instance.closeRetainedInternal(id, host)).rejects.toThrow()
    expect(state.storage.kv.get('openedAt')).toBeDefined()
    expect(state.storage.kv.get(ADMISSION_KEY)).toBeDefined()
    expect(state.storage.kv.get(CLOSE_RECEIPT_KEY)).toBeUndefined()
  })
})

it('retains retryable closure if an attachment delete fails', async () => {
  const r = await setup(),
    blob = 'blob000000000000000002'
  const put = await r.room.fetch(`https://room/internal/kept/${r.id}/blobs/${blob}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${r.caps.editor}` },
    body: Uint8Array.of(7),
  })
  expect(put.status).toBe(204)
  await runInDurableObject(r.room, async (instance: Room, state) => {
    const spy = vi.spyOn(env.BLOBS, 'delete').mockRejectedValueOnce(new Error('delete failed'))
    try {
      expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
        state: 'closed',
        cleanup: 'pending',
      })
    } finally {
      spy.mockRestore()
    }
    expect(await state.storage.getAlarm()).not.toBeNull()
    expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
      state: 'closed',
      cleanup: 'complete',
    })
  })
})

it('converges concurrent close requests to the same durable receipt', async () => {
  const r = await setup()
  await runInDurableObject(r.room, async (instance: Room) => {
    const outcomes = await Promise.allSettled([
      instance.closeRetainedInternal(r.id, r.host),
      instance.closeRetainedInternal(r.id, r.host),
    ])
    expect(outcomes.some((result) => result.status === 'fulfilled')).toBe(true)
    expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
      state: 'closed',
      cleanup: 'untracked',
    })
  })
})

it('rolls back receipt and closure if cleanup cannot be armed', async () => {
  const r = await setup(),
    blob = 'blob000000000000000003'
  const put = await r.room.fetch(`https://room/internal/kept/${r.id}/blobs/${blob}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${r.caps.editor}` },
    body: Uint8Array.of(7),
  })
  expect(put.status).toBe(204)
  await runInDurableObject(r.room, async (instance: Room, state) => {
    await state.storage.deleteAlarm()
    const spy = vi.spyOn(state.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm failed'))
    try {
      await expect(instance.closeRetainedInternal(r.id, r.host)).rejects.toThrow('alarm failed')
    } finally {
      spy.mockRestore()
    }
    expect(state.storage.kv.get(CLOSE_RECEIPT_KEY)).toBeUndefined()
    expect(state.storage.kv.get(ADMISSION_KEY)).toBeDefined()
    expect(state.storage.sql.exec('SELECT * FROM durable_checkpoint').toArray()).toHaveLength(1)
    expect(await instance.closeRetainedInternal(r.id, r.host)).toEqual({
      state: 'closed',
      cleanup: 'complete',
    })
  })
})
