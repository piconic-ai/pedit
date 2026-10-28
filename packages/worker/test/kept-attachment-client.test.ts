import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { blobIdFor, contentHash, deriveBlobKeys, encryptBlob } from '../../protocol/src/blob.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../protocol/src/kept-access.ts'
import { KeptAttachmentClient } from '../../protocol/src/kept-attachment-client.ts'
import access from '../../testdata/kept-access-vectors.json'
import { KeptTransport } from '../src/kept-transport.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
it('reuses the first ciphertext after checking a separately encrypted copy', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const keys = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, id)
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(room, async (_, state) => {
    const t = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await t.initialize(
      id,
      host,
      {
        editor: keys.editAdmission!,
        commenter: keys.commentAdmission!,
        reader: keys.readAdmission,
      },
      'epoch',
      Uint8Array.of(1).buffer,
    )
  })
  const calls: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init),
      res = await room.fetch(req)
    calls.push(`${req.method}:${res.status}`)
    return res
  }
  const readOnly = await deriveKeptRoomKeys(parseKeptFragment(keys.fragments.read!)!, id)
  expect(
    () => new KeptAttachmentClient({ url: 'https://room', keys: readOnly, fetch: fetcher }),
  ).toThrow('editor access required')
  const client = new KeptAttachmentClient({ url: 'https://room', keys, fetch: fetcher })
  const plain = new TextEncoder().encode('same image')
  const a = await client.upload(plain),
    b = await client.upload(plain)
  expect(a.disposition).toBe('stored')
  expect(b).toEqual({ hash: a.hash, disposition: 'reused' })
  expect(calls).toEqual(['PUT:204', 'PUT:409', 'GET:200'])
  const sent: Uint8Array[] = []
  let dropped = false
  const flaky: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    if (req.method === 'PUT') sent.push(new Uint8Array(await req.clone().arrayBuffer()))
    const response = await room.fetch(req)
    if (req.method === 'PUT' && !dropped) {
      dropped = true
      throw new Error('response lost')
    }
    return response
  }
  const retried = await new KeptAttachmentClient({
    url: 'https://room',
    keys,
    fetch: flaky,
  }).upload(new TextEncoder().encode('next image'))
  expect(retried.disposition).toBe('stored')
  expect(sent).toHaveLength(2)
  expect(sent[0]).toEqual(sent[1])
  let unavailablePuts = 0
  const unavailable: typeof fetch = async (_input, init) => {
    if (init?.method === 'PUT') unavailablePuts++
    return new Response(null, { status: init?.method === 'PUT' ? 409 : 404 })
  }
  await expect(
    new KeptAttachmentClient({ url: 'https://room', keys, fetch: unavailable }).upload(plain),
  ).rejects.toThrow('unavailable')
  expect(unavailablePuts).toBe(12)
  const oversized: typeof fetch = async (_input, init) =>
    init?.method === 'PUT'
      ? new Response(null, { status: 409 })
      : new Response(new Uint8Array(10 * 1024 * 1024 + 1))
  await expect(
    new KeptAttachmentClient({ url: 'https://room', keys, fetch: oversized }).upload(plain),
  ).rejects.toThrow('too large')

  const blobKeys = await deriveBlobKeys(keys.frameSecret, keys.editAdmission!)
  const blobID = await blobIdFor(blobKeys, a.hash)
  const prefix = await runInDurableObject(room, (_, state) => `kept/${state.id.toString()}/`)
  await env.BLOBS.put(
    prefix + blobID,
    await encryptBlob(blobKeys, new TextEncoder().encode('other data')),
  )
  await expect(client.upload(plain)).rejects.toThrow()
  expect(calls.slice(-2)).toEqual(['PUT:409', 'GET:200'])
  expect(await contentHash(plain)).toBe(a.hash)
})

it('retries a simultaneous upload until the first stored ciphertext can be verified', async () => {
  const host = token(),
    id = await roomIdFor(host)
  const keys = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, id)
  const room = env.ROOM.get(env.ROOM.idFromName(id))
  await runInDurableObject(room, async (_, state) => {
    const t = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await t.initialize(
      id,
      host,
      {
        editor: keys.editAdmission!,
        commenter: keys.commentAdmission!,
        reader: keys.readAdmission,
      },
      'epoch',
      Uint8Array.of(1).buffer,
    )
  })
  const plain = new TextEncoder().encode('same image')
  const blobKeys = await deriveBlobKeys(keys.frameSecret, keys.editAdmission!)
  const idForImage = await blobIdFor(blobKeys, await contentHash(plain))
  const encrypted = await encryptBlob(blobKeys, plain)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      entered()
      await gate
      c.enqueue(encrypted)
      c.close()
    },
  })
  const first = room.fetch(`https://room/internal/kept/${id}/blobs/${idForImage}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${keys.editAdmission}` },
    body,
  })
  await waiting
  const calls: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init),
      response = await room.fetch(req)
    calls.push(`${req.method}:${response.status}`)
    if (req.method === 'GET' && response.status === 404) release()
    return response
  }
  try {
    const result = await new KeptAttachmentClient({
      url: 'https://room',
      keys,
      fetch: fetcher,
    }).upload(plain)
    expect(result.disposition).toBe('reused')
    expect(calls.slice(0, 2)).toEqual(['PUT:409', 'GET:404'])
    expect(calls.slice(-2)).toEqual(['PUT:409', 'GET:200'])
    expect((await first).status).toBe(204)
  } finally {
    release()
  }
})

it('bounds PUT, GET, and response body waiting even when abort is ignored', async () => {
  const keys = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, access.roomId)
  for (const stall of ['put', 'get', 'body'] as const) {
    let calls = 0
    const fetcher: typeof fetch = async (_input, init) => {
      calls++
      if (
        (stall === 'put' && init?.method === 'PUT') ||
        (stall === 'get' && init?.method !== 'PUT')
      )
        return new Promise<Response>(() => {})
      if (init?.method === 'PUT') return new Response(null, { status: 409 })
      return new Response(
        new ReadableStream({
          pull() {
            return new Promise<void>(() => {})
          },
          cancel() {
            return new Promise<void>(() => {})
          },
        }),
      )
    }
    const client = new KeptAttachmentClient({
      url: 'https://room',
      keys,
      fetch: fetcher,
      timeoutMs: 50,
    })
    await expect(client.upload(Uint8Array.of(1))).rejects.toThrow('interrupted')
    expect(calls).toBe(stall === 'put' ? 1 : 2)
  }
})

it('does not continue after a timed-out GET resolves late', async () => {
  const keys = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, access.roomId)
  let calls = 0,
    release!: (response: Response) => void
  const fetcher: typeof fetch = async (_input, init) => {
    calls++
    if (init?.method === 'PUT') return new Response(null, { status: 409 })
    return new Promise<Response>((resolve) => {
      release = resolve
    })
  }
  const client = new KeptAttachmentClient({
    url: 'https://room',
    keys,
    fetch: fetcher,
    timeoutMs: 50,
  })
  await expect(client.upload(Uint8Array.of(1))).rejects.toThrow('interrupted')
  release(new Response(null, { status: 404 }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(calls).toBe(2)
})
