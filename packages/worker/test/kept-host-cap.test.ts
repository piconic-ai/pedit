import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { MAX_PEERS } from '../src/room.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

it('caps concurrent host connections and admits a new host after a close', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const path = `https://room/internal/kept/${id}`
  const response = await stub.fetch(`${path}/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Host ${host}`,
      'X-Pedit-Editor': caps.editor,
      'X-Pedit-Commenter': caps.commenter,
      'X-Pedit-Reader': caps.reader,
      'X-Pedit-Epoch': 'one',
      'X-Pedit-Keep-Seconds': '60',
    },
    body: new Uint8Array([1]),
  })
  expect(response.status).toBe(204)
  const connect = () =>
    stub.fetch(`${path}/host`, { headers: { Upgrade: 'websocket', Authorization: `Host ${host}` } })
  const attempts = await Promise.all(Array.from({ length: MAX_PEERS + 4 }, connect))
  expect(attempts.filter((r) => r.status === 101)).toHaveLength(MAX_PEERS)
  expect(attempts.filter((r) => r.status === 429)).toHaveLength(4)
  const sockets = attempts.flatMap((r) => (r.webSocket ? [r.webSocket] : []))
  for (const socket of sockets) socket.accept()
  sockets[0]!.close(1000)
  await expect
    .poll(() => runInDurableObject(stub, (_, state) => state.getWebSockets('kept-host').length))
    .toBe(MAX_PEERS - 1)
  const replacement = await connect()
  expect(replacement.status).toBe(101)
  replacement.webSocket!.accept()
  replacement.webSocket!.close(1000)
  for (const socket of sockets.slice(1)) socket.close(1000)
})
