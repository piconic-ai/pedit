import { createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { RELAY_MESSAGE_RATE } from '@pedit/protocol/pace'
import { expect, it } from 'vitest'
import { MAX_BODY_CHUNKS } from '../src/bounded-body.ts'
import app from '../src/index.ts'
import { KeptAppendRate } from '../src/kept-append.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
async function setup() {
  const host = token(),
    id = await roomIdFor(host)
  const caps = { editor: token(), commenter: token(), reader: token() }
  const stub = env.ROOM.get(env.ROOM.idFromName(id)),
    base = `https://room/internal/kept/${id}`
  const response = await stub.fetch(`${base}/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Host ${host}`,
      'X-Pedit-Editor': caps.editor,
      'X-Pedit-Commenter': caps.commenter,
      'X-Pedit-Reader': caps.reader,
      'X-Pedit-Epoch': 'one',
      'X-Pedit-Keep-Seconds': '60',
    },
    body: Uint8Array.of(10),
  })
  expect(response.status).toBe(204)
  const write = (auth: string, body: Uint8Array, epoch = 'one') =>
    stub.fetch(`${base}/append`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'X-Pedit-Epoch': epoch },
      body: Uint8Array.from(body),
    })
  return { id, caps, stub, base, write }
}

it('releases the append slot when an immediate body exceeds the chunk limit', async () => {
  const { id, caps, stub } = await setup()
  await runInDurableObject(stub, async (instance) => {
    let count = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (count++ <= MAX_BODY_CHUNKS) controller.enqueue(new Uint8Array())
        else controller.close()
      },
    })
    const headers = { Authorization: `Bearer ${caps.editor}`, 'X-Pedit-Epoch': 'one' }
    const response = await instance.fetch(
      new Request(`https://room/internal/kept/${id}/append`, { method: 'POST', headers, body }),
    )
    expect(response.status).toBe(400)
    const next = await instance.fetch(
      new Request(`https://room/internal/kept/${id}/append`, {
        method: 'POST',
        headers,
        body: Uint8Array.of(42),
      }),
    )
    expect(next.status).toBe(200)
  })
})
it('stores editor and commenter ciphertext once and reads a fixed tail', async () => {
  const { caps, stub, base, write } = await setup()
  const first = await write(caps.editor, Uint8Array.of(1, 2))
  expect(first.status).toBe(200)
  expect(first.headers.get('Cache-Control')).toBe('no-store')
  const { sequence } = await first.json<{ sequence: number }>()
  expect(sequence).toBe(1)
  expect(await (await write(caps.editor, Uint8Array.of(1, 2))).json()).toEqual({ sequence })
  const begin = await stub.fetch(`${base}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${caps.reader}` },
  })
  const snapshot = await begin.json<{ session: string; cursor: string }>()
  expect((await write(caps.commenter, Uint8Array.of(3))).status).toBe(200)
  const page = await stub.fetch(`${base}/read`, {
    headers: {
      Authorization: `Bearer ${caps.reader}`,
      'X-Pedit-Read-Session': snapshot.session,
      'X-Pedit-Read-Cursor': snapshot.cursor,
    },
  })
  const contents = await page.json<{ entries: { sequence: number; ciphertext: string }[] }>()
  expect(contents.entries).toEqual([{ sequence: 1, ciphertext: 'AQI=' }])
})
it('rejects unauthorized, stale, malformed and oversized requests', async () => {
  const { caps, stub, base, write } = await setup()
  expect((await write(caps.reader, Uint8Array.of(1))).status).toBe(403)
  expect((await write(token(), Uint8Array.of(1))).status).toBe(403)
  expect((await write(caps.editor, Uint8Array.of(1), 'other')).status).toBe(403)
  expect((await write(caps.editor, new Uint8Array())).status).toBe(400)
  expect((await write(caps.editor, new Uint8Array(MAX_FRAME_BYTES + 1))).status).toBe(413)
  expect((await stub.fetch(`${base}/append`)).status).toBe(405)
})
it('refuses expired rooms and remains inaccessible through the public Worker', async () => {
  const { id, caps, stub, write } = await setup()
  await runInDurableObject(stub, async (_, state) => {
    const now = Date.now()
    state.storage.kv.put('keptLifetime', {
      host: 'away',
      requestedSeconds: 1,
      keepSeconds: 1,
      departedAt: now - 2000,
      keepUntil: now - 1000,
      totalUntil: null,
      observedAt: now - 2000,
    })
  })
  expect((await write(caps.editor, Uint8Array.of(1))).status).toBe(403)
  const response = await app.fetch(
    new Request(`https://room/api/rooms/${id}/append`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${caps.editor}`, 'X-Pedit-Epoch': 'one' },
      body: Uint8Array.of(1),
    }),
    env,
    createExecutionContext(),
  )
  expect(response.status).toBe(404)
})
it('rate-limits authenticated requests through Room fetch', async () => {
  const { caps, write, stub } = await setup()
  await runInDurableObject(stub, (instance) => {
    Object.defineProperty(instance, 'keptAppendRate', { value: new KeptAppendRate(() => 0) })
  })
  for (let i = 0; i < RELAY_MESSAGE_RATE.burst; i++) {
    const r = await write(caps.editor, new Uint8Array())
    expect(r.status).toBe(400)
  }
  expect((await write(caps.editor, new Uint8Array())).status).toBe(429)
}, 20000)

it('refuses and closes the kept room during maintenance', async () => {
  const { caps, stub, write } = await setup()
  await runInDurableObject(stub, (instance) => {
    instance['env'] = { ...instance['env'], MAINTENANCE: 'closed' } as Env
  })
  expect((await write(caps.editor, Uint8Array.of(1))).status).toBe(403)
  await runInDurableObject(stub, async (_, state) => {
    expect(state.storage.kv.get('admissionHash')).toBeUndefined()
    expect(state.storage.sql.exec('SELECT * FROM durable_log').toArray()).toEqual([])
  })
})

it('does not let a comment-tier burst exhaust the editor allowance', async () => {
  const { caps, write, stub } = await setup()
  await runInDurableObject(stub, (instance) => {
    Object.defineProperty(instance, 'keptAppendRate', { value: new KeptAppendRate(() => 0) })
  })
  let limited = false
  for (let i = 0; i <= RELAY_MESSAGE_RATE.burst; i++) {
    const result = await write(caps.commenter, new Uint8Array())
    if (result.status === 429) {
      limited = true
      break
    }
    expect(result.status).toBe(400)
  }
  expect(limited).toBe(true)
  expect((await write(caps.editor, Uint8Array.of(9))).status).toBe(200)
}, 20000)

it('releases same-tier slots when request bodies stall', async () => {
  const { id, caps, stub } = await setup()
  await runInDurableObject(stub, async (instance) => {
    let entered = 0
    let allEntered!: () => void
    const ready = new Promise<void>((resolve) => {
      allEntered = resolve
    })
    const requests = Array.from({ length: 8 }, () => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          if (++entered === 8) allEntered()
        },
        cancel() {
          return new Promise<void>(() => {})
        },
      })
      return instance.fetch(
        new Request(`https://room/internal/kept/${id}/append`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${caps.editor}`, 'X-Pedit-Epoch': 'one' },
          body,
        }),
      )
    })
    await ready
    const request = () =>
      new Request(`https://room/internal/kept/${id}/append`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${caps.editor}`, 'X-Pedit-Epoch': 'one' },
        body: Uint8Array.of(42),
      })
    expect((await instance.fetch(request())).status).toBe(429)
    const timedOut = await Promise.all(requests)
    expect(timedOut.map((response) => response.status)).toEqual(Array(8).fill(408))
    expect((await instance.fetch(request())).status).toBe(200)
  })
}, 45_000)
