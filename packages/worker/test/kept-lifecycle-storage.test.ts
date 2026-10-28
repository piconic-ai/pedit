import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import type { Room } from '../src/room.ts'
import { DurableLog } from '../src/durable-log.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

it('rolls back alarm and synchronous storage together', async () => {
  const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
  await runInDurableObject(stub, async (_: Room, state) => {
    const deadline = Date.now() + 60_000
    await expect(state.storage.transaction(async () => {
      state.storage.kv.put('probe', 'a')
      await state.storage.setAlarm(deadline)
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(state.storage.kv.get('probe')).toBeUndefined()
    expect(await state.storage.getAlarm()).toBeNull()
  })
})

it('rolls back log clear inside alarm transaction', async () => {
  const stub = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
  await runInDurableObject(stub, async (_: Room, state) => {
    state.storage.kv.put(ADMISSION_KEY, new Uint8Array([1]).buffer)
    const log = new DurableLog(state.storage, { bytes: 100, frames: 5 })
    await log.initialize('epoch', new Uint8Array([2]).buffer)
    await log.append('epoch', new Uint8Array([3]).buffer)
    await expect(state.storage.transaction(async () => {
      DurableLog.clear(state.storage)
      state.storage.kv.delete(ADMISSION_KEY)
      await state.storage.setAlarm(Date.now() + 60_000)
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(state.storage.kv.get(ADMISSION_KEY)).toBeDefined()
    expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toHaveLength(1)
  })
})
