import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { KeptTransport } from '../src/kept-transport.ts'
import type { Room } from '../src/room.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
async function setup(guestLimit?: string, readerLimit?: string) {
  const host = token(),
    id = await roomIdFor(host)
  const caps = { editor: token(), commenter: token(), reader: token() }
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(room, async (instance: Room, state) => {
    if (guestLimit || readerLimit)
      instance['env'] = {
        ...instance['env'],
        ROOM_GUESTS: guestLimit,
        ROOM_READERS: readerLimit,
      } as Env
    await new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    ).initializeAway(id, host, caps, 'one', Uint8Array.of(1).buffer)
  })
  const sockets: WebSocket[] = []
  const connect = async (admission: string) => {
    const result = await room.fetch(`https://room/internal/kept/${id}/guest`, {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `pedit-v6, pedit-admission.${admission}`,
      },
    })
    if (result.webSocket) {
      result.webSocket.accept()
      sockets.push(result.webSocket)
    }
    return result.status
  }
  return { room, host, id, caps, sockets, connect }
}
it('reserves host, editor and commenter capacity against readers', async () => {
  const f = await setup('31', '31')
  try {
    for (let i = 0; i < 31; i++) expect(await f.connect(f.caps.reader)).toBe(101)
    expect(await f.connect(f.caps.reader)).toBe(429)
    expect(await f.connect(f.caps.commenter)).toBe(101)
    expect(await f.connect(f.caps.editor)).toBe(101)
    const host = await f.room.fetch(`https://room/internal/kept/${f.id}/host`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Host ${f.host}`,
      },
    })
    expect(host.status).toBe(101)
    host.webSocket!.accept()
    f.sockets.push(host.webSocket!)
  } finally {
    for (const s of f.sockets) s.close()
  }
})
it('respects configured reader and writer limits while reserving an editor', async () => {
  const f = await setup('2', '1')
  try {
    expect(await f.connect(f.caps.reader)).toBe(101)
    expect(await f.connect(f.caps.reader)).toBe(429)
    expect(await f.connect(f.caps.commenter)).toBe(101)
    expect(await f.connect(f.caps.commenter)).toBe(101)
    expect(await f.connect(f.caps.commenter)).toBe(429)
    expect(await f.connect(f.caps.editor)).toBe(101)
    expect(await f.connect(f.caps.editor)).toBe(101)
    expect(await f.connect(f.caps.editor)).toBe(429)
  } finally {
    for (const s of f.sockets) s.close()
  }
})

it('reserves an editor and host against commenters', async () => {
  const f = await setup('31', '31')
  try {
    for (let i = 0; i < 31; i++) expect(await f.connect(f.caps.commenter)).toBe(101)
    expect(await f.connect(f.caps.commenter)).toBe(429)
    expect(await f.connect(f.caps.editor)).toBe(101)
    const host = await f.room.fetch(`https://room/internal/kept/${f.id}/host`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Host ${f.host}`,
      },
    })
    expect(host.status).toBe(101)
    host.webSocket!.accept()
    f.sockets.push(host.webSocket!)
  } finally {
    for (const s of f.sockets) s.close()
  }
})

it('reserves the only configured writer slot for an editor', async () => {
  const f = await setup('1', '1')
  try {
    expect(await f.connect(f.caps.commenter)).toBe(101)
    expect(await f.connect(f.caps.editor)).toBe(101)
    expect(f.sockets[0]?.readyState).not.toBe(WebSocket.OPEN)
  } finally {
    for (const s of f.sockets) s.close()
  }
})
