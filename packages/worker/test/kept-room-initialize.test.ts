import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { expect, it } from 'vitest'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

it('initializes away through Room fetch and tracks the authenticated host socket', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const path = `https://room/internal/kept/${id}`
  const headers = {
    Authorization: `Host ${host}`,
    'X-Pedit-Editor': caps.editor,
    'X-Pedit-Commenter': caps.commenter,
    'X-Pedit-Reader': caps.reader,
    'X-Pedit-Epoch': 'one',
    'X-Pedit-Keep-Seconds': '60',
  }
  const initialize = () =>
    stub.fetch(`${path}/initialize`, { method: 'POST', headers, body: new Uint8Array([1, 2]) })
  expect(
    (
      await stub.fetch(`${path}/initialize`, {
        method: 'POST',
        headers: { ...headers, Authorization: `Host ${token()}` },
        body: new Uint8Array([1]),
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await stub.fetch(`${path}/initialize`, {
        method: 'POST',
        headers,
        body: new Uint8Array(MAX_FRAME_BYTES + 1),
      })
    ).status,
  ).toBe(403)
  await runInDurableObject(stub, async (_, state) => {
    expect(state.storage.kv.get('keptLifetime')).toBeUndefined()
  })
  expect((await initialize()).status).toBe(204)
  await runInDurableObject(stub, async (_, state) => {
    expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('away')
    expect(await state.storage.getAlarm()).not.toBeNull()
  })
  await evictDurableObject(stub)
  expect((await initialize()).status).toBe(204)
  expect(
    (
      await stub.fetch(`${path}/host`, {
        headers: { Upgrade: 'websocket', Authorization: `Host ${token()}` },
      })
    ).status,
  ).toBe(403)
  const response = await stub.fetch(`${path}/host`, {
    headers: { Upgrade: 'websocket', Authorization: `Host ${host}` },
  })
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (!socket) throw new Error('missing socket')
  socket.accept()
  const secondResponse = await stub.fetch(`${path}/host`, {
    headers: { Upgrade: 'websocket', Authorization: `Host ${host}` },
  })
  expect(secondResponse.status).toBe(101)
  const second = secondResponse.webSocket
  if (!second) throw new Error('missing second socket')
  second.accept()
  await runInDurableObject(stub, async (_, state) => {
    expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('connected')
    expect(state.getWebSockets('kept-host')).toHaveLength(2)
  })
  socket.close(1000, 'bye')
  await expect
    .poll(async () =>
      runInDurableObject(stub, async (_, state) => state.getWebSockets('kept-host').length),
    )
    .toBe(1)
  await runInDurableObject(stub, async (_, state) => {
    expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('connected')
  })
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (room, state) => {
    await room.alarm()
    expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('connected')
    expect(state.getWebSockets('kept-host')).toHaveLength(1)
  })
  second.close(1000, 'bye')
  await viWait(stub)
})

async function viWait(stub: DurableObjectStub): Promise<void> {
  await expect
    .poll(async () =>
      runInDurableObject(
        stub,
        async (_, state) => state.storage.kv.get<{ host: string }>('keptLifetime')?.host,
      ),
    )
    .toBe('away')
}
