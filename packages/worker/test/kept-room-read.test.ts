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
