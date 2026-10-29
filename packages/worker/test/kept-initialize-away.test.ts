import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { KeptTransport } from '../src/kept-transport.ts'
import { roomIdFor } from '../src/room-identity.ts'
import { ADMISSION_KEY } from '../src/room-storage.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const policy = { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: 30, alarmSeconds: 60 }

it('atomically stores admission, away lifetime, checkpoint and alarm', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const checkpoint = new Uint8Array([1, 2]).buffer
  const transport = (state: DurableObjectState) =>
    new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy)
  await runInDurableObject(stub, async (_, state) => {
    const t = transport(state)
    const spy = vi.spyOn(state.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm failed'))
    try {
      await expect(t.initializeAway(id, host, caps, 'one', checkpoint)).rejects.toThrow(
        'alarm failed',
      )
    } finally {
      spy.mockRestore()
    }
    expect(state.storage.kv.get(ADMISSION_KEY)).toBeUndefined()
    expect(state.storage.kv.get('keptLifetime')).toBeUndefined()
    expect(state.storage.kv.get('keptPolicy')).toBeUndefined()
    await t.initializeAway(id, host, caps, 'one', checkpoint)
    expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('away')
    expect(await state.storage.getAlarm()).not.toBeNull()
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_, state) => {
    const t = transport(state)
    await t.initializeAway(id, host, caps, 'one', checkpoint)
    expect(new Uint8Array((await t.beginRead(caps.reader)).ciphertext)).toEqual(
      new Uint8Array([1, 2]),
    )
    await expect(
      t.initializeAway(id, host, caps, 'one', new Uint8Array([3]).buffer),
    ).rejects.toThrow()
  })
})

it('retries an initialization whose acknowledgement was lost after commit', async () => {
  const host = token()
  const id = await roomIdFor(host)
  const caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(stub, async (_, state) => {
    const transport = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy)
    const spy = vi
      .spyOn(state.storage, 'sync')
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
    try {
      await expect(
        transport.initializeAway(id, host, caps, 'one', new Uint8Array([5]).buffer),
      ).rejects.toThrow('lost acknowledgement')
    } finally {
      spy.mockRestore()
    }
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_, state) => {
    const transport = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy)
    await transport.initializeAway(id, host, caps, 'one', new Uint8Array([5]).buffer)
    expect(new Uint8Array((await transport.beginRead(caps.reader)).ciphertext)).toEqual(
      new Uint8Array([5]),
    )
  })
})

it('does not combine concurrent initializations with different credentials', async () => {
  const host = token()
  const id = await roomIdFor(host)
  const first = { editor: token(), commenter: token(), reader: token() }
  const second = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(stub, async (_, state) => {
    const transport = new KeptTransport(state, env.ROOM, { bytes: 100, frames: 10 }, policy)
    const outcomes = await Promise.allSettled([
      transport.initializeAway(id, host, first, 'one', new Uint8Array([1]).buffer),
      transport.initializeAway(id, host, second, 'one', new Uint8Array([2]).buffer),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const winner = outcomes[0]?.status === 'fulfilled' ? first : second
    const expected = outcomes[0]?.status === 'fulfilled' ? 1 : 2
    expect(new Uint8Array((await transport.beginRead(winner.reader)).ciphertext)).toEqual(
      new Uint8Array([expected]),
    )
    const loser = winner === first ? second : first
    await expect(transport.beginRead(loser.reader)).rejects.toThrow()
  })
})
