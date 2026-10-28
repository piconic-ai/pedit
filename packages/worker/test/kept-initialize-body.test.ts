import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { MAX_BODY_CHUNKS } from '../src/bounded-body.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

it('authenticates before reading, limits stalled uploads, and releases their slots', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  const url = `https://room/internal/kept/${id}/initialize`
  const headers = {
    Authorization: `Host ${host}`,
    'X-Pedit-Editor': caps.editor,
    'X-Pedit-Commenter': caps.commenter,
    'X-Pedit-Reader': caps.reader,
    'X-Pedit-Epoch': 'one',
    'X-Pedit-Keep-Seconds': '60',
  }
  await runInDurableObject(stub, async (room) => {
    let entered = 0
    let enteredAll!: () => void
    const ready = new Promise<void>((resolve) => {
      enteredAll = resolve
    })
    const stalled = () =>
      new ReadableStream<Uint8Array>({
        pull() {
          if (++entered === 5) enteredAll()
        },
        cancel() {
          return new Promise<void>(() => {})
        },
      })
    const request = (body: BodyInit, auth = host) =>
      new Request(url, {
        method: 'POST',
        headers: { ...headers, Authorization: `Host ${auth}` },
        body,
      })
    expect((await room.fetch(request(stalled(), token()))).status).toBe(403)
    const pending = Array.from({ length: 4 }, () => room.fetch(request(stalled())))
    await ready
    expect((await room.fetch(request(new Uint8Array([1])))).status).toBe(429)
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([408, 408, 408, 408])
    expect((await room.fetch(request(new Uint8Array([1])))).status).toBe(204)
  })
}, 45_000)

it('rejects an excessive number of chunks before initializing the room', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(stub, async (room, state) => {
    let count = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++count > MAX_BODY_CHUNKS + 1) controller.close()
        else controller.enqueue(new Uint8Array())
      },
    })
    const response = await room.fetch(
      new Request(`https://room/internal/kept/${id}/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Host ${host}`,
          'X-Pedit-Editor': caps.editor,
          'X-Pedit-Commenter': caps.commenter,
          'X-Pedit-Reader': caps.reader,
          'X-Pedit-Epoch': 'one',
          'X-Pedit-Keep-Seconds': '60',
        },
        body,
      }),
    )
    expect(response.status).toBe(400)
    expect(state.storage.kv.get('keptLifetime')).toBeUndefined()
  })
})
