import { createExecutionContext, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { expect, it } from 'vitest'
import app from '../src/index.ts'
import { initializeKeptRoom } from '../src/kept-room-initialize.ts'
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
  ).toBe(413)
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

it('clamps an authenticated Worker initialization and reports the applied duration', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const url = `https://room/internal/kept/${id}/initialize`
  const headers = {
    Authorization: `Host ${host}`,
    'X-Pedit-Editor': caps.editor,
    'X-Pedit-Commenter': caps.commenter,
    'X-Pedit-Reader': caps.reader,
    'X-Pedit-Epoch': 'one',
    'X-Pedit-Keep-Seconds': '99999999999999999999999999999999',
  }
  const publicAttempt = await app.fetch(
    new Request(`https://room/api/rooms/${id}/initialize`, {
      method: 'POST',
      headers,
      body: new Uint8Array([1]),
    }),
    env,
    createExecutionContext(),
  )
  expect(publicAttempt.status).toBe(404)
  const denied = await stub.fetch(url, {
    method: 'POST',
    headers: { ...headers, Authorization: `Host ${token()}` },
    body: new Uint8Array([1]),
  })
  expect(denied.status).toBe(403)
  const response = await stub.fetch(url, { method: 'POST', headers, body: new Uint8Array([1]) })
  expect(response.status).toBe(204)
  expect(response.headers.get('X-Pedit-Keep-Seconds')).toBe('120')
  await runInDurableObject(stub, (_, state) => {
    const life = state.storage.kv.get<{
      host: string
      keepSeconds: number
      requestedSeconds: number
    }>('keptLifetime')
    expect(life?.host).toBe('away')
    expect(life?.keepSeconds).toBe(120)
    expect(life?.requestedSeconds).toBe(120)
  })
  await evictDurableObject(stub)
  const retry = await stub.fetch(url, { method: 'POST', headers, body: new Uint8Array([1]) })
  expect(retry.status).toBe(204)
  expect(retry.headers.get('X-Pedit-Keep-Seconds')).toBe('120')
})

it('allows longer keeps when self-host limit is unset and fails closed on invalid config', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const url = `https://room/internal/kept/${id}/initialize`
  const headers = {
    Authorization: `Host ${host}`,
    'X-Pedit-Editor': caps.editor,
    'X-Pedit-Commenter': caps.commenter,
    'X-Pedit-Reader': caps.reader,
    'X-Pedit-Epoch': 'one',
    'X-Pedit-Keep-Seconds': '1209600',
  }
  await runInDurableObject(stub, async (_, state) => {
    const base = { ...env, KEEP_MAX_SECONDS: undefined }
    const request = () => new Request(url, { method: 'POST', headers, body: new Uint8Array([1]) })
    for (const bad of ['', '0', '-1', '1e3', '9007199254740992']) {
      const r = await initializeKeptRoom(
        request(),
        state,
        { ...base, KEEP_MAX_SECONDS: bad },
        id,
        null,
        () => false,
      )
      expect(r.status).toBe(503)
      expect(state.storage.kv.get('keptLifetime')).toBeUndefined()
    }
    const ok = await initializeKeptRoom(request(), state, base, id, null, () => false)
    expect(ok.status).toBe(204)
    expect(ok.headers.get('X-Pedit-Keep-Seconds')).toBe('1209600')
    expect(state.storage.kv.get<{ keepSeconds: number }>('keptLifetime')?.keepSeconds).toBe(1209600)
  })
})

it('rejects invalid and unrepresentable requested durations before initialization', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const url = `https://room/internal/kept/${id}/initialize`
  const headers = {
    Authorization: `Host ${host}`,
    'X-Pedit-Editor': caps.editor,
    'X-Pedit-Commenter': caps.commenter,
    'X-Pedit-Reader': caps.reader,
    'X-Pedit-Epoch': 'one',
  }
  for (const value of ['0', '-1', '1e3', '01', '9'.repeat(33)]) {
    const r = await stub.fetch(url, {
      method: 'POST',
      headers: { ...headers, 'X-Pedit-Keep-Seconds': value },
      body: new Uint8Array([1]),
    })
    expect(r.status).toBe(400)
  }
  await runInDurableObject(stub, async (_, state) => {
    const r = await initializeKeptRoom(
      new Request(url, {
        method: 'POST',
        headers: { ...headers, 'X-Pedit-Keep-Seconds': '9007199254740991' },
        body: new Uint8Array([1]),
      }),
      state,
      { ...env, KEEP_MAX_SECONDS: undefined },
      id,
      null,
      () => false,
    )
    expect(r.status).toBe(400)
    expect(state.storage.kv.get('keptLifetime')).toBeUndefined()
  })
})

it('retries with the persisted policy after configuration changes', async () => {
  const host = token(),
    id = await roomIdFor(host),
    caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const url = `https://room/internal/kept/${id}/initialize`
  const headers = {
    Authorization: `Host ${host}`,
    'X-Pedit-Editor': caps.editor,
    'X-Pedit-Commenter': caps.commenter,
    'X-Pedit-Reader': caps.reader,
    'X-Pedit-Epoch': 'one',
    'X-Pedit-Keep-Seconds': '200',
  }
  expect(
    (await stub.fetch(url, { method: 'POST', headers, body: new Uint8Array([1]) })).status,
  ).toBe(204)
  await evictDurableObject(stub)
  await runInDurableObject(stub, async (_, state) => {
    const original = state.storage.kv.get('keptPolicy')
    for (const maximum of ['60', '300', undefined]) {
      const request = () => new Request(url, { method: 'POST', headers, body: new Uint8Array([1]) })
      const result = await initializeKeptRoom(
        request(),
        state,
        { ...env, KEEP_MAX_SECONDS: maximum },
        id,
        2,
        () => false,
      )
      expect(result.status).toBe(204)
      expect(result.headers.get('X-Pedit-Keep-Seconds')).toBe('120')
      expect(state.storage.kv.get('keptPolicy')).toEqual(original)
    }
    const bad = await initializeKeptRoom(
      new Request(url, {
        method: 'POST',
        headers: { ...headers, Authorization: `Host ${token()}` },
        body: new Uint8Array([1]),
      }),
      state,
      { ...env, KEEP_MAX_SECONDS: '60' },
      id,
      null,
      () => false,
    )
    expect(bad.status).toBe(403)
    const changed = await initializeKeptRoom(
      new Request(url, { method: 'POST', headers, body: new Uint8Array([2]) }),
      state,
      { ...env, KEEP_MAX_SECONDS: '60' },
      id,
      null,
      () => false,
    )
    expect(changed.status).toBe(403)
    expect(state.storage.kv.get('keptPolicy')).toEqual(original)
  })
})
