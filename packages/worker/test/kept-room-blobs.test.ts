import { createExecutionContext, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { decrypt, encrypt } from '../../protocol/src/cipher.ts'
import app from '../src/index.ts'
import { KeptTransport } from '../src/kept-transport.ts'
import type { Room } from '../src/room.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const blob = (n: number) => `blob${String(n).padStart(18, '0')}`
const setup = async () => {
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
  await runInDurableObject(room, async (_, state) => {
    await transport(state).initialize(id, host, caps, 'epoch', Uint8Array.of(1).buffer)
  })
  return { host, id, caps, room, transport, url: `https://room/internal/kept/${id}/blobs` }
}

it('authorizes kept uploads and reads and enforces room quota', async () => {
  const { host, id, caps, room, url } = await setup()
  const call = (n: number, method: string, tokenValue: string, body?: Uint8Array) =>
    room.fetch(`${url}/${blob(n)}`, {
      method,
      headers: { Authorization: `Bearer ${tokenValue}` },
      body: body ? Uint8Array.from(body).buffer : undefined,
    })
  expect((await call(1, 'PUT', caps.reader, Uint8Array.of(1))).status).toBe(403)
  expect((await call(1, 'PUT', caps.commenter, Uint8Array.of(1))).status).toBe(403)
  expect((await call(1, 'PUT', token(), Uint8Array.of(1))).status).toBe(403)
  const first = Uint8Array.from({ length: 60 }, (_, i) => i)
  expect((await call(1, 'PUT', caps.editor, first)).status).toBe(204)
  await evictDurableObject(room)
  expect((await call(2, 'PUT', caps.editor, new Uint8Array(50))).status).toBe(403)
  expect((await call(1, 'PUT', caps.editor, first)).status).toBe(204)
  expect((await call(1, 'PUT', caps.editor, new Uint8Array(60))).status).toBe(409)
  expect((await call(1, 'PUT', caps.editor, Uint8Array.of(1))).status).toBe(409)
  expect(
    (
      await room.fetch(`${url}/${blob(3)}`, {
        method: 'PUT',
        headers: { Authorization: `Host ${host}` },
        body: Uint8Array.of(7),
      })
    ).status,
  ).toBe(204)
  const hostRead = await room.fetch(`${url}/${blob(3)}`, {
    headers: { Authorization: `Host ${host}` },
  })
  expect(hostRead.status).toBe(200)
  expect(new Uint8Array(await hostRead.arrayBuffer())).toEqual(Uint8Array.of(7))
  const wrongRoom = 'A'.repeat(22)
  expect(
    (
      await room.fetch(`https://room/internal/kept/${wrongRoom}/blobs/${blob(3)}`, {
        headers: { Authorization: `Host ${host}` },
      })
    ).status,
  ).toBe(404)
  for (const cap of [caps.editor, caps.commenter, caps.reader]) {
    const response = await call(1, 'GET', cap)
    expect(response.status).toBe(200)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(first)
  }
  expect((await call(1, 'GET', token())).status).toBe(403)
  const publicResponse = await app.fetch(
    new Request(`https://room/api/rooms/${id}/blobs/${blob(1)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${caps.reader}` },
    }),
    env,
    createExecutionContext(),
  )
  expect(publicResponse.status).toBe(403)
})

it('closes and sweeps R2 after host close, including across eviction', async () => {
  const { host, id, caps, room, transport, url } = await setup()
  expect(
    (
      await room.fetch(`${url}/${blob(1)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${caps.editor}` },
        body: Uint8Array.of(1),
      })
    ).status,
  ).toBe(204)
  const prefix = await runInDurableObject(room, (_, state) => `kept/${state.id.toString()}/`)
  await runInDurableObject(room, async (_, state) => {
    await transport(state).close(id, host)
    expect(await state.storage.getAlarm()).not.toBeNull()
  })
  expect(
    (await room.fetch(`${url}/${blob(1)}`, { headers: { Authorization: `Bearer ${caps.reader}` } }))
      .status,
  ).toBe(403)
  expect(await env.BLOBS.head(prefix + blob(1))).not.toBeNull()
  await evictDurableObject(room)
  await runInDurableObject(room, async (instance: Room) => {
    await instance.alarm()
  })
  expect(await env.BLOBS.head(prefix + blob(1))).toBeNull()
})

it('expires before read or upload and sweeps on the room alarm', async () => {
  const { caps, room, url } = await setup()
  expect(
    (
      await room.fetch(`${url}/${blob(1)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${caps.editor}` },
        body: Uint8Array.of(1),
      })
    ).status,
  ).toBe(204)
  const prefix = await runInDurableObject(room, (_, state) => {
    const now = Date.now()
    state.storage.kv.put('keptLifetime', {
      host: 'away',
      observedAt: now - 2000,
      requestedSeconds: 1,
      totalUntil: null,
      departedAt: now - 2000,
      keepSeconds: 1,
      keepUntil: now - 1000,
    })
    return `kept/${state.id.toString()}/`
  })
  expect(
    (await room.fetch(`${url}/${blob(1)}`, { headers: { Authorization: `Bearer ${caps.reader}` } }))
      .status,
  ).toBe(403)
  expect(
    (
      await room.fetch(`${url}/${blob(2)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${caps.editor}` },
        body: Uint8Array.of(2),
      })
    ).status,
  ).toBe(403)
  await runInDurableObject(room, async (instance: Room) => {
    await instance.alarm()
  })
  expect(await env.BLOBS.head(prefix + blob(1))).toBeNull()
})

it('does not start an R2 PUT when close occurs while the request body is streaming', async () => {
  const { host, id, caps, room, transport, url } = await setup()
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    reached = resolve
  })
  let pulls = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (++pulls === 1) {
        controller.enqueue(Uint8Array.of(1))
        return
      }
      reached()
      await gate
      controller.close()
    },
  })
  const pending = room.fetch(`${url}/${blob(1)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${caps.editor}` },
    body: stream,
  })
  await entered
  try {
    await runInDurableObject(room, async (_, state) => {
      await transport(state).close(id, host)
    })
  } finally {
    release()
  }
  expect((await pending).status).toBe(403)
  const prefix = await runInDurableObject(room, (_, state) => `kept/${state.id.toString()}/`)
  expect(await env.BLOBS.head(prefix + blob(1))).toBeNull()
})

it('keeps the room and cleanup state open if arming close fails', async () => {
  const { host, id, caps, room, transport, url } = await setup()
  expect(
    (
      await room.fetch(`${url}/${blob(1)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${caps.editor}` },
        body: Uint8Array.of(1),
      })
    ).status,
  ).toBe(204)
  await runInDurableObject(room, async (_, state) => {
    await state.storage.deleteAlarm()
    const spy = vi.spyOn(state.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm failed'))
    try {
      await expect(transport(state).close(id, host)).rejects.toThrow('alarm failed')
    } finally {
      spy.mockRestore()
    }
    expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('connected')
    expect(
      state.storage.sql.exec<{ closed: number }>('SELECT closed FROM kept_blob_state').one().closed,
    ).toBe(0)
    await transport(state).close(id, host)
    expect(
      state.storage.sql.exec<{ closed: number }>('SELECT closed FROM kept_blob_state').one().closed,
    ).toBe(1)
    expect(await state.storage.getAlarm()).not.toBeNull()
  })
})

it('reserves a host upload slot and releases stalled editor bodies on timeout', {
  timeout: 45_000,
}, async () => {
  const { host, caps, room, url } = await setup()
  const stalled = Array.from({ length: 3 }, (_, i) => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {})
      },
      cancel() {
        return new Promise<void>(() => {})
      },
    })
    return room.fetch(`${url}/${blob(i + 1)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${caps.editor}` },
      body,
    })
  })
  await expect
    .poll(() =>
      runInDurableObject(
        room,
        (instance: Room) =>
          (instance as unknown as { keptUploading: Map<string, string> }).keptUploading.size,
      ),
    )
    .toBe(3)
  const rejected = await room.fetch(`${url}/${blob(4)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${caps.editor}` },
    body: Uint8Array.of(1),
  })
  expect(rejected.status).toBe(409)
  const hostUpload = await room.fetch(`${url}/${blob(5)}`, {
    method: 'PUT',
    headers: { Authorization: `Host ${host}` },
    body: Uint8Array.of(2),
  })
  expect(hostUpload.status).toBe(204)
  const expired = await Promise.all(stalled)
  expect(expired.map((response) => response.status)).toEqual([403, 403, 403])
  expect(
    (
      await room.fetch(`${url}/${blob(6)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${caps.editor}` },
        body: Uint8Array.of(3),
      })
    ).status,
  ).toBe(204)
})

it('returns a conflict for a newly encrypted copy of the same plaintext', async () => {
  const { caps, room, url } = await setup()
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ])
  const plain = new TextEncoder().encode('same image')
  const first = await encrypt(key, plain),
    second = await encrypt(key, plain)
  expect(first).not.toEqual(second)
  const put = (data: Uint8Array) =>
    room.fetch(`${url}/${blob(1)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${caps.editor}` },
      body: Uint8Array.from(data).buffer,
    })
  expect((await put(first)).status).toBe(204)
  expect((await put(second)).status).toBe(409)
  const existing = await room.fetch(`${url}/${blob(1)}`, {
    headers: { Authorization: `Bearer ${caps.editor}` },
  })
  expect(await decrypt(key, new Uint8Array(await existing.arrayBuffer()))).toEqual(plain)
})

it('preserves initialized host and append behavior while cleaning kept attachments', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const caps = { editor: token(), commenter: token(), reader: token() }
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  const base = `https://room/internal/kept/${id}`
  const initialized = await room.fetch(`${base}/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Host ${host}`,
      'X-Pedit-Editor': caps.editor,
      'X-Pedit-Commenter': caps.commenter,
      'X-Pedit-Reader': caps.reader,
      'X-Pedit-Epoch': 'one',
      'X-Pedit-Keep-Seconds': '60',
    },
    body: Uint8Array.of(1),
  })
  expect(initialized.status).toBe(204)
  const connection = await room.fetch(`${base}/host`, {
    headers: { Upgrade: 'websocket', Authorization: `Host ${host}` },
  })
  expect(connection.status).toBe(101)
  const socket = connection.webSocket
  if (!socket) throw new Error('missing host socket')
  socket.accept()
  expect(
    (
      await room.fetch(`${base}/append`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${caps.editor}`, 'X-Pedit-Epoch': 'one' },
        body: Uint8Array.of(2),
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await room.fetch(`${base}/blobs/${blob(1)}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${caps.editor}` },
        body: Uint8Array.of(3),
      })
    ).status,
  ).toBe(204)
  const prefix = await runInDurableObject(room, async (instance: Room, state) => {
    await instance.alarm()
    expect(state.storage.kv.get<{ host: string }>('keptLifetime')?.host).toBe('connected')
    expect(state.getWebSockets('kept-host')).toHaveLength(1)
    return `kept/${state.id.toString()}/`
  })
  expect(await env.BLOBS.head(prefix + blob(1))).not.toBeNull()
  await runInDurableObject(room, async (_, state) => {
    await new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    ).close(id, host)
  })
  await runInDurableObject(room, async (instance: Room) => {
    await instance.alarm()
  })
  expect(await env.BLOBS.head(prefix + blob(1))).toBeNull()
  expect(
    (
      await room.fetch(`${base}/append`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${caps.editor}`, 'X-Pedit-Epoch': 'one' },
        body: Uint8Array.of(4),
      })
    ).status,
  ).toBe(403)
  socket.close()
})

it('rejects fragmented upload bodies and releases the upload slot', async () => {
  const { id, caps, room } = await setup()
  await runInDurableObject(room, async (instance: Room) => {
    let chunks = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ <= 16_384) controller.enqueue(new Uint8Array())
        else controller.close()
      },
    })
    const url = `https://room/internal/kept/${id}/blobs/${blob(1)}`
    const headers = { Authorization: `Bearer ${caps.editor}` }
    expect((await instance.fetch(new Request(url, { method: 'PUT', headers, body }))).status).toBe(
      403,
    )
    expect(
      (await instance.fetch(new Request(url, { method: 'PUT', headers, body: Uint8Array.of(1) })))
        .status,
    ).toBe(204)
  })
})
