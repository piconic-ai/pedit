import { createExecutionContext, evictDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { expect, it, vi } from 'vitest'
import app from '../src/index.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const active = () => ({ ...env, KEEP_PUBLIC_V6: '1' })
const request = (
  path: string,
  init?: RequestInit,
  bindings: Parameters<typeof app.fetch>[1] = active(),
) =>
  app.fetch(new Request(`https://relay.example${path}`, init), bindings, createExecutionContext())

it('is disabled unless explicitly enabled and fails closed without rate limits', async () => {
  const id = await roomIdFor(token()),
    path = `/internal/kept/${id}/initialize`
  expect((await request(path, { method: 'POST' }, { ...env, KEEP_PUBLIC_V6: '' })).status).toBe(404)
  expect((await request(path, { method: 'POST' }, { ...env, KEEP_PUBLIC_V6: 'true' })).status).toBe(
    404,
  )
  expect(
    (await request(path, { method: 'POST' }, { ...active(), CONNECTION_LIMIT: undefined })).status,
  ).toBe(503)
  expect(
    (await request(path, { method: 'POST' }, { ...active(), ROOM_CREATION_LIMIT: undefined }))
      .status,
  ).toBe(503)
})

it('enforces origin, id, method, query and rate before forwarding', async () => {
  const id = await roomIdFor(token()),
    base = `/internal/kept/${id}`
  expect(
    (
      await request(`${base}/read`, {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await request(`${base}/guest`, {
        headers: { Upgrade: 'websocket', Origin: 'https://attacker.example' },
      })
    ).status,
  ).toBe(403)
  expect((await request(`${base}/read?secret=hidden`, { method: 'POST' })).status).toBe(400)
  const insecure = await app.fetch(
    new Request(`http://relay.example${base}/read?secret=hidden`),
    active(),
    createExecutionContext(),
  )
  expect(insecure.status).toBe(400)
  expect(insecure.headers.get('Location')).toBeNull()
  expect(await insecure.text()).not.toContain('hidden')
  for (const path of [
    `/%69nternal/kept/${id}/read?secret=sentinel`,
    `/internal%2fkept/${id}/read?secret=sentinel`,
    `/%69nternal/kept/${id}/read#sentinel`,
    `/%69nternal/kept/${id}/read%ff?secret=sentinel`,
  ]) {
    const response = await app.fetch(
      new Request(`http://relay.example${path}`),
      active(),
      createExecutionContext(),
    )
    expect(response.status).toBe(400)
    expect(response.headers.get('Location')).toBeNull()
    expect(await response.text()).not.toContain('sentinel')
  }
  expect((await request(`/%69nternal/kept/${id}/read`, { method: 'POST' })).status).toBe(400)
  expect(
    (
      await request(
        `/%69nternal/kept/${id}/read`,
        { method: 'POST' },
        { ...env, KEEP_PUBLIC_V6: '' },
      )
    ).status,
  ).toBe(404)
  expect((await request('/internal/kept/not-an-id/read', { method: 'POST' })).status).toBe(400)
  expect((await request(`${base}/toString`)).status).toBe(400)
  expect((await request(`${base}/append`, { method: 'GET' })).status).toBe(405)
  expect(
    (await request(`${base}/read`, { method: 'POST', headers: { Upgrade: 'websocket' } })).status,
  ).toBe(400)
  const deny = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit
  expect(
    (await request(`${base}/read`, { method: 'POST' }, { ...active(), CONNECTION_LIMIT: deny }))
      .status,
  ).toBe(429)
  expect(deny.limit).toHaveBeenCalledOnce()
  expect(
    (
      await request(
        `${base}/initialize`,
        { method: 'POST' },
        { ...active(), ROOM_CREATION_LIMIT: deny },
      )
    ).status,
  ).toBe(429)
})

it('forwards only authenticated ciphertext operations to the matching Room', async () => {
  const host = token(),
    id = await roomIdFor(host),
    editor = token(),
    commenter = token(),
    reader = token()
  const base = `/internal/kept/${id}`,
    room = env.ROOM.get(env.ROOM.idFromName(id))
  const common = {
    Authorization: `Host ${host}`,
    'X-Pedit-Editor': editor,
    'X-Pedit-Commenter': commenter,
    'X-Pedit-Reader': reader,
    'X-Pedit-Epoch': 'one',
    'X-Pedit-Keep-Seconds': '60',
  }
  const logs = vi.spyOn(console, 'log')
  try {
    expect(
      (
        await request(`${base}/initialize`, {
          method: 'POST',
          headers: { ...common, Authorization: `Host ${token()}` },
          body: Uint8Array.of(1),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request(`${base}/initialize`, {
          method: 'POST',
          headers: common,
          body: new Uint8Array(MAX_FRAME_BYTES + 1),
        })
      ).status,
    ).toBe(413)
    const init = await request(`${base}/initialize`, {
      method: 'POST',
      headers: common,
      body: Uint8Array.of(1, 2, 3),
    })
    expect(init.status).toBe(204)
    expect(
      (
        await request(`${base}/append`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${reader}`, 'X-Pedit-Epoch': 'one' },
          body: Uint8Array.of(7),
        })
      ).status,
    ).toBe(403)
    const append = await request(`${base}/append`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${editor}`, 'X-Pedit-Epoch': 'one' },
      body: Uint8Array.of(7),
    })
    expect(append.status).toBe(200)
    await append.arrayBuffer()
    const snapshot = await request(`${base}/read`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${reader}` },
    })
    expect(snapshot.status).toBe(200)
    const data = await snapshot.json<{ tail: number; session: string }>()
    expect(data.tail).toBe(1)
    expect(
      (
        await request(`${base}/read`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${reader}`, 'X-Pedit-Read-Session': data.session },
        })
      ).status,
    ).toBe(204)
    const guest = await request(`${base}/guest`, {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `pedit-v6, pedit-admission.${reader}`,
      },
    })
    expect(guest.status).toBe(101)
    guest.webSocket!.accept()
    const blobId = 'blob000000000000000001'
    expect(
      (
        await request(`${base}/blobs/${blobId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${reader}` },
          body: Uint8Array.of(5),
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request(`${base}/blobs/${blobId}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${editor}` },
          body: Uint8Array.of(5, 6),
        })
      ).status,
    ).toBe(204)
    const blob = await request(`${base}/blobs/${blobId}`, {
      headers: { Authorization: `Bearer ${reader}` },
    })
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(Uint8Array.of(5, 6))
    expect(
      (
        await request(`${base}/close`, {
          method: 'POST',
          headers: { Authorization: `Host ${token()}` },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await request(`${base}/close`, {
          method: 'POST',
          headers: { Authorization: `Host ${host}` },
        })
      ).status,
    ).toBe(204)
    expect(
      (
        await request(`${base}/read`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${reader}` },
        })
      ).status,
    ).toBe(403)

    guest.webSocket!.close()
    expect(JSON.stringify(logs.mock.calls)).not.toContain(host)
    expect(JSON.stringify(logs.mock.calls)).not.toContain(editor)
    expect(JSON.stringify(logs.mock.calls)).not.toContain(reader)
  } finally {
    logs.mockRestore()
    await evictDurableObject(room, { webSockets: 'close' })
  }
}, 20000)

it('forwards only allowlisted headers and does not log downstream failures', async () => {
  const host = token(),
    id = await roomIdFor(host),
    secret = token()
  let forwarded: Request | undefined
  const fake = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async (r: Request) => {
        forwarded = r
        return new Response(null, { status: 204 })
      },
    }),
  } as unknown as Env['ROOM']
  const response = await request(
    `/internal/kept/${id}/initialize`,
    {
      method: 'POST',
      headers: {
        Authorization: `Host ${host}`,
        'X-Pedit-Host': '1',
        'X-Secret-Not-For-Room': secret,
      },
      body: Uint8Array.of(1),
    },
    { ...active(), ROOM: fake },
  )
  expect(response.status).toBe(204)
  expect(forwarded?.headers.get('Authorization')).toBe(`Host ${host}`)
  expect(forwarded?.headers.has('X-Pedit-Host')).toBe(false)
  expect(forwarded?.headers.has('X-Secret-Not-For-Room')).toBe(false)
  const log = vi.spyOn(console, 'error')
  const failing = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => {
        throw new Error(secret)
      },
    }),
  } as unknown as Env['ROOM']
  try {
    const failure = await request(
      `/internal/kept/${id}/read`,
      { method: 'POST' },
      { ...active(), ROOM: failing },
    )
    expect(failure.status).toBe(503)
    expect(await failure.text()).not.toContain(secret)
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
  } finally {
    log.mockRestore()
  }
})

it('keeps maintenance and the public v5 route unchanged', async () => {
  const id = await roomIdFor(token()),
    path = `/internal/kept/${id}`
  expect(
    (
      await request(
        `${path}/initialize`,
        { method: 'POST' },
        { ...active(), MAINTENANCE: 'no-new-rooms' },
      )
    ).status,
  ).toBe(503)
  expect(
    (await request(`${path}/read`, { method: 'POST' }, { ...active(), MAINTENANCE: 'closed' }))
      .status,
  ).toBe(503)
  expect((await request(`${path}/unknown/extra`)).status).toBe(404)
  const legacy = await request('/api/rooms', { method: 'POST' }, { ...env, KEEP_PUBLIC_V6: '' })
  expect(legacy.status).toBe(201)
  await legacy.arrayBuffer()
})
