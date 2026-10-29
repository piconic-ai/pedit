import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { DurableLog } from '../src/durable-log.ts'
import { KeptAdmission } from '../src/kept-admission.ts'
import { KeptTransport } from '../src/kept-transport.ts'
import { roomIdFor } from '../src/room-identity.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

it('keeps an away room on alarm and closes it at expiry after eviction', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const capabilities = { editor: token(), commenter: token(), reader: token() }
  let expires = 0
  await runInDurableObject(stub, async (room, state) => {
    const t = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 100, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await t.initialize(id, host, capabilities, 'one', new Uint8Array([1]).buffer)
    await t.append(capabilities.editor, 'one', new Uint8Array([2]).buffer)
    await t.leave(id, host)
    const lifetime = state.storage.kv.get<{ host: string; keepUntil: number }>('keptLifetime')
    if (!lifetime || lifetime.host !== 'away') throw new Error('missing away state')
    expires = lifetime.keepUntil
    await room.alarm()
    expect(state.storage.kv.get(ADMISSION_KEY)).toBeDefined()
    expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toHaveLength(1)
    expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('away')
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (room, state) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expires)
    try {
      await room.alarm()
      expect(state.storage.kv.get(ADMISSION_KEY)).toBeUndefined()
      expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toEqual([])
      expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('closed')
    } finally {
      clock.mockRestore()
    }
  })
})

it('does not use v5 cleanup if kept admission exists without a lifetime', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const capabilities = { editor: token(), commenter: token(), reader: token() }
  await runInDurableObject(stub, async (room, state) => {
    await new KeptAdmission(state, env.ROOM).register(id, host, capabilities)
    await expect(room.alarm()).resolves.toBeUndefined()
    expect(await state.storage.getAlarm()).not.toBeNull()
    expect(state.storage.kv.get(ADMISSION_KEY)).toBeDefined()
  })
})

it('reschedules an expired room cleanup after the delivered alarm is consumed', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const caps = { editor: token(), commenter: token(), reader: token() }
  await runInDurableObject(stub, async (room, state) => {
    const t = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 100, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await t.initialize(id, host, caps, 'one', new Uint8Array([1]).buffer)
    await t.append(caps.editor, 'one', new Uint8Array([2]).buffer)
    const left = await t.leave(id, host)
    if (left.host !== 'away') throw new Error('expected away')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(left.keepUntil)
    const cleanup = vi.spyOn(DurableLog, 'clear').mockImplementationOnce(() => {
      throw new Error('cleanup failed')
    })
    try {
      await state.storage.deleteAlarm()
      await expect(room.alarm()).resolves.toBeUndefined()
      expect(await state.storage.getAlarm()).not.toBeNull()
      expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('closed')
      expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toHaveLength(1)
      await state.storage.deleteAlarm()
      await room.alarm()
      expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toEqual([])
    } finally {
      cleanup.mockRestore()
      clock.mockRestore()
    }
  })
})
