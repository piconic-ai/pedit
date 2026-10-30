import { createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { admissionProtocols } from '@pedit/protocol/admission'
import { expect, it } from 'vitest'
import app, { roomIdFor } from '../src/index.ts'
import { keptText } from '../src/kept-text.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
it('applies creation and request limits even to a directly minted host token', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const request = () =>
    new Request(`https://room/api/rooms/${id}/keep/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host}` },
      body: Uint8Array.of(1),
    })
  const deny = { limit: async () => ({ success: false }) }
  expect(
    (await app.fetch(request(), { ...env, ROOM_CREATION_LIMIT: deny }, createExecutionContext()))
      .status,
  ).toBe(429)
  expect(
    (await app.fetch(request(), { ...env, KEEP_REQUEST_LIMIT: deny }, createExecutionContext()))
      .status,
  ).toBe(429)
})
it('keeps editor admission distinct from reader admission and truncates only an acknowledged prefix', async () => {
  const host = token(),
    id = await roomIdFor(host),
    editor = token(),
    reader = token()
  const base = `https://room/api/rooms/${id}/keep`
  const send = (action: string, init: RequestInit = {}) =>
    app.fetch(new Request(base + action, init), env, createExecutionContext())
  const auth = { Authorization: `Bearer ${host}` }
  const initialized = await send('/init', {
    method: 'POST',
    headers: {
      ...auth,
      'X-Pedit-Editor': editor,
      'X-Pedit-Reader': reader,
      'X-Pedit-Keep-Seconds': '999999',
    },
    body: Uint8Array.of(9),
  })
  expect(initialized.status).toBe(200)
  expect((await initialized.json<{ keepSeconds: number }>()).keepSeconds).toBe(604800)
  expect((await send('/away', { method: 'POST', headers: auth })).status).toBe(200)
  const away = await send('', { headers: auth })
  expect((await away.json<{ hostAway: boolean }>()).hostAway).toBe(true)
  expect((await send('/connect', { method: 'POST', headers: auth })).status).toBe(200)
  const connected = await send('', { headers: { 'X-Pedit-Admission': reader } })
  expect((await connected.json<{ hostAway: boolean }>()).hostAway).toBe(false)
  expect((await send('/checkpoint', { headers: auth })).status).toBe(403)
  expect(
    (
      await send('/append', {
        method: 'POST',
        headers: { 'X-Pedit-Admission': reader, 'X-Pedit-Sender': 'guest' },
        body: Uint8Array.of(1),
      })
    ).status,
  ).toBe(403)
  for (const n of [1, 2])
    expect(
      (
        await send('/append', {
          method: 'POST',
          headers: { 'X-Pedit-Admission': editor, 'X-Pedit-Sender': 'guest' },
          body: Uint8Array.of(n),
        })
      ).status,
    ).toBe(200)
  expect(
    (
      await send('/checkpoint', {
        method: 'POST',
        headers: { ...auth, 'X-Pedit-Cutoff': '1' },
        body: Uint8Array.of(8),
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await send('/append', {
        method: 'POST',
        headers: { 'X-Pedit-Admission': editor, 'X-Pedit-Sender': 'guest' },
        body: new Uint8Array(1024 * 1024 + 1),
      })
    ).status,
  ).toBe(400)
  const response = await send('', { headers: { 'X-Pedit-Admission': reader } })
  expect(response.status).toBe(200)
  const data = await response.json<{ snapshot: string; entries: { id: number }[]; tail: number }>()
  expect(data.snapshot).toBe(btoa(String.fromCharCode(8)))
  expect(data.entries.map((row) => row.id)).toEqual([2])
  expect(data.tail).toBe(2)
  expect(
    (
      await send('/checkpoint', {
        method: 'POST',
        headers: { ...auth, 'X-Pedit-Cutoff': '0' },
        body: Uint8Array.of(7),
      })
    ).status,
  ).toBe(400)
})

it('rolls back initial ciphertext when its cleanup alarm cannot be scheduled', async () => {
  const room = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()))
  await runInDurableObject(room, async (_, state) => {
    const storage = new Proxy(state.storage, {
      get(target, property) {
        if (property === 'setAlarm')
          return async () => {
            throw new Error('alarm storage unavailable')
          }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const request = () =>
      new Request('https://room/api/rooms/test/keep/init', {
        method: 'POST',
        headers: {
          'X-Pedit-Editor': token(),
          'X-Pedit-Reader': token(),
          'X-Pedit-Keep-Seconds': '60',
        },
        body: Uint8Array.of(1, 2, 3),
      })
    expect((await keptText(request(), storage, true, undefined, undefined)).status).toBe(400)
    await state.storage.sync()
    expect(state.storage.kv.get('keptText')).toBeUndefined()
    expect(await state.storage.getAlarm()).toBeNull()
    expect((await keptText(request(), state.storage, true, undefined, undefined)).status).toBe(200)
    expect(await state.storage.getAlarm()).not.toBeNull()
  })
})

it('rejects new kept rooms during maintenance while allowing existing room reads', async () => {
  const host = token(),
    id = await roomIdFor(host),
    editor = token(),
    reader = token()
  const base = `https://room/api/rooms/${id}/keep`
  const init = () =>
    new Request(`${base}/init`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${host}`,
        'X-Pedit-Editor': editor,
        'X-Pedit-Reader': reader,
        'X-Pedit-Keep-Seconds': '60',
      },
      body: Uint8Array.of(1),
    })
  const maintenance = { ...env, MAINTENANCE: 'no-new-rooms' }
  expect((await app.fetch(init(), maintenance, createExecutionContext())).status).toBe(503)
  expect((await app.fetch(init(), env, createExecutionContext())).status).toBe(200)
  const read = new Request(base, { headers: { 'X-Pedit-Admission': reader } })
  expect((await app.fetch(read, maintenance, createExecutionContext())).status).toBe(200)
})
it('never mixes kept and legacy socket or blob lifecycles, including a closed kept room', async () => {
  const host = token(),
    id = await roomIdFor(host),
    editor = token(),
    reader = token()
  const base = `https://room/api/rooms/${id}`
  const init = new Request(`${base}/keep/init`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${host}`,
      'X-Pedit-Editor': editor,
      'X-Pedit-Reader': reader,
      'X-Pedit-Keep-Seconds': '60',
    },
    body: Uint8Array.of(1),
  })
  expect((await app.fetch(init, env, createExecutionContext())).status).toBe(200)
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  const before = await runInDurableObject(room, (_, state) => state.storage.getAlarm())
  const socket = () =>
    new Request(`${base}/ws`, {
      headers: {
        Authorization: `Bearer ${host}`,
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': admissionProtocols(editor).join(', '),
      },
    })
  const response = await app.fetch(socket(), env, createExecutionContext())
  if (response.webSocket) {
    response.webSocket.accept()
    response.webSocket.close()
  }
  expect(response.status).toBe(409)
  expect(await runInDurableObject(room, (_, state) => state.storage.getAlarm())).toBe(before)
  await runInDurableObject(room, (_, state) => {
    state.storage.kv.delete('keptText')
    state.storage.kv.put('keptTextClosed', true)
  })
  expect((await app.fetch(socket(), env, createExecutionContext())).status).toBe(409)
  const blob = new Request(`${base}/blobs/${'a'.repeat(22)}`, {
    headers: { Authorization: `Bearer ${host}` },
  })
  expect((await app.fetch(blob, env, createExecutionContext())).status).toBe(409)
})
