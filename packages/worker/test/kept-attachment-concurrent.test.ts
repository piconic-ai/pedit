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
it('waits for a slow concurrent upload within the deadline', async () => {
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
  const blobID = await blobIdFor(blobKeys, await contentHash(plain))
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
  const pending = room.fetch(`https://room/internal/kept/${id}/blobs/${blobID}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${keys.editAdmission}` },
    body,
  })
  await waiting
  await expect
    .poll(() => runInDurableObject(room, (instance) => instance['keptUploading'].has(blobID)))
    .toBe(true)
  const fetcher: typeof fetch = (input, init) => room.fetch(new Request(input, init))
  try {
    setTimeout(release, 3200)
    const result = await new KeptAttachmentClient({
      url: 'https://room',
      keys,
      fetch: fetcher,
    }).upload(plain)
    expect(result.disposition).toBe('reused')
  } finally {
    release()
    expect((await pending).status).toBe(204)
  }
})
it('stops a conflicting upload at its deadline', async () => {
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
  const blobID = await blobIdFor(blobKeys, await contentHash(plain))
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
  const pending = room.fetch(`https://room/internal/kept/${id}/blobs/${blobID}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${keys.editAdmission}` },
    body,
  })
  await waiting
  await expect
    .poll(() => runInDurableObject(room, (instance) => instance['keptUploading'].has(blobID)))
    .toBe(true)
  const fetcher: typeof fetch = (input, init) => room.fetch(new Request(input, init))
  try {
    await expect(
      new KeptAttachmentClient({
        url: 'https://room',
        keys,
        fetch: fetcher,
        timeoutMs: 500,
      }).upload(plain),
    ).rejects.toThrow('interrupted')
  } finally {
    release()
    expect((await pending).status).toBe(204)
  }
})
