import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { blobIdFor, contentHash, deriveBlobKeys, encryptBlob } from '../../protocol/src/blob.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../protocol/src/kept-access.ts'
import { KeptAttachmentClient } from '../../protocol/src/kept-attachment-client.ts'
import { verifyKeptAttachment } from '../../protocol/src/kept-attachment-verify.ts'
import access from '../../testdata/kept-access-vectors.json'
import { KeptTransport } from '../src/kept-transport.ts'
import { roomIdFor } from '../src/room-identity.ts'

const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

it('verifies known encrypted blobs for each tier without sending plaintext or keys', async () => {
  const host = token(),
    roomId = await roomIdFor(host)
  const edit = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, roomId)
  const room = env.ROOM.get(env.ROOM.idFromName(roomId))
  await runInDurableObject(room, async (_, state) => {
    const transport = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 100, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    )
    await transport.initialize(
      roomId,
      host,
      {
        editor: edit.editAdmission!,
        commenter: edit.commentAdmission!,
        reader: edit.readAdmission,
      },
      'epoch',
      Uint8Array.of(1).buffer,
    )
  })
  const plain = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
  const fetcher: typeof fetch = (input, init) => room.fetch(new Request(input, init))
  const uploaded = await new KeptAttachmentClient({
    url: 'https://room',
    keys: edit,
    fetch: fetcher,
  }).upload(plain)
  const path = `assets/${uploaded.hash}.png`
  const blobKeys = await deriveBlobKeys(edit.frameSecret, edit.readAdmission)
  const id = await blobIdFor(blobKeys, uploaded.hash)
  for (const fragment of [access.edit, edit.fragments.comment!, edit.fragments.read!]) {
    const keys = await deriveKeptRoomKeys(parseKeptFragment(fragment)!, roomId)
    const requests: Request[] = []
    const fetchChecked: typeof fetch = (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      return room.fetch(request)
    }
    const result = await verifyKeptAttachment(
      { url: 'https://room', keys, fetch: fetchChecked },
      path,
    )
    expect(result.bytes).toEqual(plain)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.method).toBe('GET')
    expect(requests[0]!.body).toBeNull()
    expect(new URL(requests[0]!.url).pathname).toBe(`/internal/kept/${roomId}/blobs/${id}`)
    expect(requests[0]!.headers.get('Authorization')).toBe(`Bearer ${keys.readAdmission}`)
    expect(requests[0]!.url).not.toContain(uploaded.hash)
    expect(requests[0]!.url).not.toContain(fragment)
  }
  await expect(
    verifyKeptAttachment(
      { url: 'https://room', keys: edit, fetch: fetcher },
      path.replace('.png', '.jpg'),
    ),
  ).rejects.toThrow('type mismatch')
  const otherRoom = await roomIdFor(token())
  const otherKeys = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, otherRoom)
  await expect(
    verifyKeptAttachment({ url: 'https://room', keys: otherKeys, fetch: fetcher }, path),
  ).rejects.toThrow()
  const denied: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token()}`)
    return room.fetch(new Request(input, { ...init, headers }))
  }
  await expect(
    verifyKeptAttachment({ url: 'https://room', keys: edit, fetch: denied }, path),
  ).rejects.toThrow()
  const missing = `assets/${'a'.repeat(32)}.png`
  await expect(
    verifyKeptAttachment({ url: 'https://room', keys: edit, fetch: fetcher }, missing),
  ).rejects.toThrow()
  const prefix = await runInDurableObject(room, (_, state) => `kept/${state.id.toString()}/`)
  await env.BLOBS.put(prefix + id, Uint8Array.of(1, 2, 3))
  await expect(
    verifyKeptAttachment({ url: 'https://room', keys: edit, fetch: fetcher }, path),
  ).rejects.toThrow()
  await env.BLOBS.put(prefix + id, await encryptBlob(blobKeys, Uint8Array.of(1, 2, 3)))
  await expect(
    verifyKeptAttachment({ url: 'https://room', keys: edit, fetch: fetcher }, path),
  ).rejects.toThrow()
  expect(await contentHash(plain)).toBe(uploaded.hash)
})

it('rejects invalid paths and bounds fetch, stream and cancellation', async () => {
  const keys = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, access.roomId)
  const path = `assets/${'a'.repeat(32)}.png`
  let calls = 0
  const stalled: typeof fetch = async () => {
    calls++
    return new Promise<Response>(() => {})
  }
  for (const bad of [
    `/${path}`,
    path.toUpperCase(),
    `${path}?x=1`,
    `assets/${'a'.repeat(32)}.svg`,
    `assets/${'a'.repeat(31)}.png`,
    `${path}\n`,
  ])
    await expect(
      verifyKeptAttachment({ url: 'https://room', keys, fetch: stalled }, bad),
    ).rejects.toThrow('invalid attachment path')
  expect(calls).toBe(0)
  await expect(
    verifyKeptAttachment({ url: 'https://room', keys, fetch: stalled, timeoutMs: 40 }, path),
  ).rejects.toThrow('interrupted')
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  const beforeAbort = calls
  await expect(
    verifyKeptAttachment(
      { url: 'https://room', keys, fetch: stalled },
      path,
      alreadyAborted.signal,
    ),
  ).rejects.toThrow('interrupted')
  expect(calls).toBe(beforeAbort)
  const controller = new AbortController()
  const pending = verifyKeptAttachment(
    { url: 'https://room', keys, fetch: stalled },
    path,
    controller.signal,
  )
  controller.abort()
  await expect(pending).rejects.toThrow('interrupted')
  const bodyStall: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        pull() {
          return new Promise<void>(() => {})
        },
        cancel() {
          return new Promise<void>(() => {})
        },
      }),
    )
  await expect(
    verifyKeptAttachment({ url: 'https://room', keys, fetch: bodyStall, timeoutMs: 40 }, path),
  ).rejects.toThrow('interrupted')
  let chunks = 0
  const fragmented: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (chunks++ < 16385) controller.enqueue(Uint8Array.of(1))
          else controller.close()
        },
      }),
    )
  await expect(
    verifyKeptAttachment({ url: 'https://room', keys, fetch: fragmented }, path),
  ).rejects.toThrow('too many attachment chunks')
  const oversized: typeof fetch = async () => new Response(new Uint8Array(10 * 1024 * 1024 + 1))
  await expect(
    verifyKeptAttachment({ url: 'https://room', keys, fetch: oversized }, path),
  ).rejects.toThrow('too large')
})

it('checks each supported image signature against its path extension', async () => {
  const keys = await deriveKeptRoomKeys(parseKeptFragment(access.edit)!, access.roomId)
  const blobKeys = await deriveBlobKeys(keys.frameSecret, keys.readAdmission)
  const images = [
    ['png', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ['jpg', Uint8Array.of(0xff, 0xd8, 0xff)],
    ['gif', new TextEncoder().encode('GIF87a')],
    ['gif', new TextEncoder().encode('GIF89a')],
    ['webp', new TextEncoder().encode('RIFF0000WEBP')],
  ] as const
  for (const [ext, plain] of images) {
    const ciphertext = await encryptBlob(blobKeys, plain)
    const path = `assets/${await contentHash(plain)}.${ext}`
    const fetcher: typeof fetch = async () => new Response(Uint8Array.from(ciphertext).buffer)
    expect(
      (await verifyKeptAttachment({ url: 'https://room', keys, fetch: fetcher }, path)).bytes,
    ).toEqual(plain)
    const wrong = path.replace(/\.[^.]+$/, ext === 'png' ? '.jpg' : '.png')
    await expect(
      verifyKeptAttachment({ url: 'https://room', keys, fetch: fetcher }, wrong),
    ).rejects.toThrow('type mismatch')
  }
})
