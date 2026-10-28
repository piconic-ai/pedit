import { createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import app from '../src/index.ts'
import { KeptTransport } from '../src/kept-transport.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const bytes = (...values: number[]) => new Uint8Array(values).buffer

it('serves an authorized fixed checkpoint and tail through Room fetch', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  const caps = { editor: token(), commenter: token(), reader: token() }
  const transport = (state: DurableObjectState) =>
    new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
  await runInDurableObject(room, async (_, state) => {
    const t = transport(state)
    await t.initialize(id, host, caps, 'epoch', bytes(1, 2))
    await t.append(caps.editor, 'epoch', bytes(3))
  })
  const url = `https://room/internal/kept/${id}/read`
  const publicResponse = await app.fetch(
    new Request(`https://room/api/rooms/${id}/read`, {
      method: 'POST',
      headers: { Authorization: `Host ${host}` },
    }),
    env,
    createExecutionContext(),
  )
  expect(publicResponse.status).toBe(404)
  const begin = (authorization: string) =>
    room.fetch(url, { method: 'POST', headers: { Authorization: authorization } })
  expect((await begin(`Bearer ${token()}`)).status).toBe(403)
  expect((await begin(`Host ${token()}`)).status).toBe(403)
  for (const auth of [
    `Host ${host}`,
    `Bearer ${caps.editor}`,
    `Bearer ${caps.commenter}`,
    `Bearer ${caps.reader}`,
  ]) {
    const response = await begin(auth)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const snapshot = await response.json<{
      ciphertext: string
      session: string
      cursor: string
      tail: number
    }>()
    expect(snapshot.ciphertext).toBe('AQI=')
    expect(snapshot.tail).toBeGreaterThanOrEqual(1)
    await runInDurableObject(room, async (_, state) => {
      await transport(state).append(caps.editor, 'epoch', bytes(4))
    })
    const headers = {
      Authorization: auth,
      'X-Pedit-Read-Session': snapshot.session,
      'X-Pedit-Read-Cursor': snapshot.cursor,
    }
    const page = await room.fetch(url, { headers })
    const result = await page.json<{ entries: { sequence: number; ciphertext: string }[] }>()
    expect(result.entries[0]).toEqual({ sequence: 1, ciphertext: 'Aw==' })
    expect(result.entries.every((entry) => entry.sequence <= snapshot.tail)).toBe(true)
    expect((await room.fetch(url, { method: 'DELETE', headers })).status).toBe(204)
  }
  await runInDurableObject(room, async (_, state) => {
    await transport(state).close(id, host)
  })
  expect((await begin(`Bearer ${caps.reader}`)).status).toBe(403)
  expect((await begin(`Host ${host}`)).status).toBe(403)
})

it('reserves host read capacity when a reader exhausts their allocation', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  const caps = { editor: token(), commenter: token(), reader: token() }
  await runInDurableObject(room, async (_, state) => {
    const t = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await t.initialize(id, host, caps, 'epoch', bytes(1))
  })
  const url = `https://room/internal/kept/${id}/read`
  const begin = (auth: string) =>
    room.fetch(url, { method: 'POST', headers: { Authorization: auth } })
  const attempts = await Promise.all(
    Array.from({ length: 60 }, () => begin(`Bearer ${caps.reader}`)),
  )
  expect(attempts.filter((response) => response.status === 200)).toHaveLength(40)
  expect(attempts.filter((response) => response.status === 403)).toHaveLength(20)
  const hosts = await Promise.all(Array.from({ length: 9 }, () => begin(`Host ${host}`)))
  expect(hosts.filter((response) => response.status === 200)).toHaveLength(9)
  expect(hosts.filter((response) => response.status === 403)).toHaveLength(0)
})

it('protects commenter, editor and host reads from lower-tier exhaustion', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  const caps = { editor: token(), commenter: token(), reader: token() }
  await runInDurableObject(room, async (_, state) => {
    const t = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await t.initialize(id, host, caps, 'epoch', bytes(1))
  })
  const url = `https://room/internal/kept/${id}/read`
  const begin = (authorization: string) =>
    room.fetch(url, { method: 'POST', headers: { Authorization: authorization } })
  const start = (authorization: string, count: number) =>
    Promise.all(Array.from({ length: count }, () => begin(authorization)))

  expect((await start(`Bearer ${caps.reader}`, 40)).every((r) => r.status === 200)).toBe(true)
  expect((await begin(`Bearer ${caps.reader}`)).status).toBe(403)
  const comments = await start(`Bearer ${caps.commenter}`, 8)
  expect(comments.every((r) => r.status === 200)).toBe(true)
  const editors = await start(`Bearer ${caps.editor}`, 8)
  expect(editors.every((r) => r.status === 200)).toBe(true)
  const hosts = await start(`Host ${host}`, 8)
  expect(hosts.every((r) => r.status === 200)).toBe(true)

  expect((await begin(`Bearer ${caps.commenter}`)).status).toBe(200)
  expect((await begin(`Bearer ${caps.editor}`)).status).toBe(200)
  expect((await begin(`Host ${host}`)).status).toBe(200)
  expect((await begin(`Bearer ${caps.reader}`)).status).toBe(403)
  for (const [auth, lower, response] of [
    [`Bearer ${caps.commenter}`, `Bearer ${caps.reader}`, comments[0]],
    [`Bearer ${caps.editor}`, `Bearer ${caps.commenter}`, editors[0]],
    [`Host ${host}`, `Bearer ${caps.editor}`, hosts[0]],
  ] as const) {
    const snapshot = await response!.json<{ session: string; cursor: string }>()
    const lowerHeaders = {
      Authorization: lower,
      'X-Pedit-Read-Session': snapshot.session,
      'X-Pedit-Read-Cursor': snapshot.cursor,
    }
    expect((await room.fetch(url, { headers: lowerHeaders })).status).toBe(403)
    expect((await room.fetch(url, { method: 'DELETE', headers: lowerHeaders })).status).toBe(403)
    const page = await room.fetch(url, {
      headers: {
        Authorization: auth,
        'X-Pedit-Read-Session': snapshot.session,
        'X-Pedit-Read-Cursor': snapshot.cursor,
      },
    })
    expect(page.status).toBe(200)
  }
})

it('upgrades a full legacy session table and lets the host preempt a reader', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  const caps = { editor: token(), commenter: token(), reader: token() }
  await runInDurableObject(room, async (_, state) => {
    const t = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await t.initialize(id, host, caps, 'epoch', bytes(1))
    const sql = state.storage.sql
    sql.exec('ALTER TABLE durable_reads DROP COLUMN host')
    for (let i = 0; i < 64; i++) {
      sql.exec(
        'INSERT INTO durable_reads (id, epoch, generation, tail, expires, cursor, after_seq) VALUES (?, ?, 1, 0, ?, ?, 0)',
        crypto.randomUUID(),
        'epoch',
        Date.now() + 300000,
        crypto.randomUUID(),
      )
    }
    await state.storage.sync()
  })
  const url = `https://room/internal/kept/${id}/read`
  const response = await room.fetch(url, {
    method: 'POST',
    headers: { Authorization: `Host ${host}` },
  })
  expect(response.status).toBe(200)
  await runInDurableObject(room, async (_, state) => {
    expect(
      state.storage.sql.exec<{ n: number }>('SELECT count(*) AS n FROM durable_reads').one().n,
    ).toBe(64)
    expect(
      state.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM durable_reads WHERE host = 1')
        .one().n,
    ).toBe(1)
  })
})

it('preserves host reservations when upgrading a table without tier priorities', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  const caps = { editor: token(), commenter: token(), reader: token() }
  await runInDurableObject(room, async (_, state) => {
    const t = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await t.initialize(id, host, caps, 'epoch', bytes(1))
    const sql = state.storage.sql
    sql.exec('ALTER TABLE durable_reads DROP COLUMN priority')
    for (let i = 0; i < 64; i++) {
      sql.exec(
        'INSERT INTO durable_reads (id, epoch, generation, tail, expires, cursor, after_seq, host) VALUES (?, ?, 1, 0, ?, ?, 0, ?)',
        crypto.randomUUID(),
        'epoch',
        Date.now() + 300000,
        crypto.randomUUID(),
        i === 63 ? 0 : 1,
      )
    }
    await state.storage.sync()
  })
  const url = `https://room/internal/kept/${id}/read`
  expect(
    (await room.fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${caps.editor}` } }))
      .status,
  ).toBe(200)
  await runInDurableObject(room, (_, state) => {
    const sql = state.storage.sql
    expect(
      sql.exec<{ n: number }>('SELECT count(*) AS n FROM durable_reads WHERE priority = 3').one().n,
    ).toBe(63)
    expect(
      sql.exec<{ n: number }>('SELECT count(*) AS n FROM durable_reads WHERE priority = 0').one().n,
    ).toBe(0)
  })
})
