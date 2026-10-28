import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { KeptTransport } from '../src/kept-transport.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

it('requires the host capability to close an initialized kept room', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(stub, async (_, state) => {
    await new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    ).initializeAway(
      id,
      host,
      { editor: token(), commenter: token(), reader: token() },
      'one',
      new Uint8Array([1]).buffer,
    )
  })
  const url = `https://room/internal/kept/${id}/close`
  const close = (value: string) =>
    stub.fetch(url, { method: 'POST', headers: { Authorization: value } })
  const other = await roomIdFor(token())
  expect(
    (
      await stub.fetch(`https://room/internal/kept/${other}/close`, {
        method: 'POST',
        headers: { Authorization: `Host ${host}` },
      })
    ).status,
  ).toBe(403)
  expect((await close(`Host ${token()}`)).status).toBe(403)
  expect((await close(`Bearer ${host}`)).status).toBe(403)
  expect(
    (await stub.fetch(url, { method: 'GET', headers: { Authorization: `Host ${host}` } })).status,
  ).toBe(405)
  expect((await close(`Host ${host}`)).status).toBe(204)
  expect(
    (
      await stub.fetch(`https://room/internal/kept/${id}/read`, {
        method: 'POST',
        headers: { Authorization: `Host ${host}` },
      })
    ).status,
  ).toBe(403)
})

it('sweeps kept attachments when the internal close route ends the room', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const editor = token(),
    commenter = token(),
    reader = token()
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(room, async (_, state) => {
    await new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    ).initializeAway(id, host, { editor, commenter, reader }, 'one', Uint8Array.of(1).buffer)
  })
  const blob = 'blob000000000000000001'
  const prefix = await runInDurableObject(room, (_, state) => `kept/${state.id.toString()}/`)
  const response = await room.fetch(`https://room/internal/kept/${id}/blobs/${blob}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${editor}` },
    body: Uint8Array.of(7),
  })
  expect(response.status).toBe(204)
  expect(await env.BLOBS.head(prefix + blob)).not.toBeNull()
  expect(
    (
      await room.fetch(`https://room/internal/kept/${id}/close`, {
        method: 'POST',
        headers: { Authorization: `Host ${host}` },
      })
    ).status,
  ).toBe(204)
  expect(await env.BLOBS.head(prefix + blob)).toBeNull()
})
