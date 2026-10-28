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

it('releases failed reads only for an authorized tier and remains idempotent', async () => {
  const host = token(),
    id = await roomIdFor(host),
    editor = token(),
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
  const url = `https://room/internal/kept/${id}/read`
  const begin = await room.fetch(url, {
    method: 'POST',
    headers: { Authorization: `Host ${host}` },
  })
  expect(begin.status).toBe(200)
  const snapshot = await begin.json<{ session: string; cursor: string }>()
  const cancel = (authorization: string) =>
    room.fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: authorization,
        'X-Pedit-Read-Session': snapshot.session,
      },
    })
  expect((await cancel(`Bearer ${reader}`)).status).toBe(403)
  expect(
    (
      await room.fetch(url, {
        headers: {
          Authorization: `Host ${host}`,
          'X-Pedit-Read-Session': snapshot.session,
          'X-Pedit-Read-Cursor': snapshot.cursor,
        },
      })
    ).status,
  ).toBe(200)
  expect((await cancel(`Host ${host}`)).status).toBe(204)
  expect((await cancel(`Host ${host}`)).status).toBe(204)
})
