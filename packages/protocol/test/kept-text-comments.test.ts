import { afterEach, expect, it } from 'vitest'
import * as Y from 'yjs'
import { deriveRoomKeys, parseFragment, type RoomKeys } from '../src/access.ts'
import { decrypt, encrypt } from '../src/cipher.ts'
import { metaPath } from '../src/files.ts'
import { KeptTextClient } from '../src/kept-text.ts'

const room = 'AAECAwQFBgcICQoLDA0ODw'
const META = 1024
const bundleDomain = new TextEncoder().encode('pedit kept files snapshot v1\0')
const fileDomain = new TextEncoder().encode('pedit kept file update v1\0')
const utf8 = new TextEncoder()
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
})
const source = () => {
  const doc = new Y.Doc()
  cleanup.push(() => doc.destroy())
  return doc
}
async function keys() {
  const link = parseFragment('A'.repeat(43))
  if (!link) throw new Error('fixture link')
  return deriveRoomKeys(link, room)
}
async function signed(k: RoomKeys, domain: Uint8Array, payload: Uint8Array): Promise<string> {
  if (!k.signer) throw new Error('fixture signer')
  const message = new Uint8Array(domain.length + payload.length)
  message.set(domain)
  message.set(payload, domain.length)
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', k.signer.key, message))
  const plain = new Uint8Array(message.length + 64)
  plain.set(message)
  plain.set(signature, message.length)
  const bytes = await encrypt(k.frameKey, plain)
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}
type File = { id: number; path: string; update: Uint8Array }
function bundle(files: File[]): Uint8Array {
  const parts: number[] = [files.length >> 8, files.length & 255]
  const u32 = (n: number) => parts.push(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  for (const file of files) {
    const path = utf8.encode(file.path)
    u32(file.id)
    parts.push(path.length >> 8, path.length & 255, ...path)
    u32(file.update.length)
    for (const byte of file.update) parts.push(byte)
  }
  return Uint8Array.from(parts)
}
const fileUpdate = (id: number, update: Uint8Array) => {
  const value = new Uint8Array(4 + update.length)
  new DataView(value.buffer).setUint32(0, id)
  value.set(update, 4)
  return value
}
const read = (snapshot: string, entries: { id: number; body: string }[] = []) =>
  Response.json({
    snapshot,
    entries,
    cutoff: 0,
    tail: entries.at(-1)?.id ?? 0,
    hostAway: true,
    keepUntil: 1234567890,
  })

/** notes.md with its paired comments doc, which holds one thread. */
function room1() {
  const text = source(),
    comments = source()
  text.getText('content').insert(0, 'hello world')
  comments.transact(() => {
    const thread = new Y.Map<unknown>()
    comments.getMap('comments').set('t1', thread)
    thread.set('quote', 'world')
  })
  return {
    text,
    comments,
    list: [
      { id: 0, path: 'notes.md', update: Y.encodeStateAsUpdate(text) },
      { id: META, path: metaPath('notes.md'), update: Y.encodeStateAsUpdate(comments) },
    ],
  }
}
function client(k: RoomKeys, fetcher: typeof fetch) {
  const doc = new Y.Doc(),
    c = new KeptTextClient({
      origin: 'https://example.test',
      roomId: room,
      keys: k,
      doc,
      fetch: fetcher,
    })
  cleanup.push(() => {
    c.close()
    doc.destroy()
  })
  return { doc, client: c }
}

it('loads a snapshot with a paired comments doc and lists it as a meta file', async () => {
  const k = await keys(),
    f = room1(),
    snapshot = await signed(k, bundleDomain, bundle(f.list))
  const x = client(k, async () => read(snapshot))
  await x.client.refresh()
  expect(x.client.state.files).toEqual([
    { id: 0, path: 'notes.md', format: 'text' },
    { id: META, path: '.pedit/meta/notes.md.json', format: 'meta' },
  ])
  expect(x.doc.getText('content').toString()).toBe('hello world')
  const thread = x.client.getDoc(META)?.getMap('comments').get('t1')
  expect((thread as Y.Map<unknown>).get('quote')).toBe('world')
})

it('applies a log entry that targets the comments doc, and queues a local thread under its id', async () => {
  const k = await keys(),
    f = room1(),
    snapshot = await signed(k, bundleDomain, bundle(f.list)),
    updates: Uint8Array[] = []
  f.comments.on('update', (u: Uint8Array) => updates.push(u))
  f.comments.transact(() => {
    const thread = new Y.Map<unknown>()
    f.comments.getMap('comments').set('t2', thread)
    thread.set('quote', 'hello')
  })
  const entry = {
    id: 1,
    body: await signed(k, fileDomain, fileUpdate(META, updates[0] as Uint8Array)),
  }
  const bodies: Uint8Array[] = []
  const x = client(k, async (_, init) => {
    if (init?.method !== 'POST') return read(snapshot, [entry])
    bodies.push(new Uint8Array(await new Response(init.body).arrayBuffer()))
    return Response.json({})
  })
  await x.client.refresh()
  const comments = x.client.getDoc(META)
  expect([...(comments?.getMap('comments').keys() ?? [])].sort()).toEqual(['t1', 't2'])
  comments?.transact(() => {
    const thread = new Y.Map<unknown>()
    comments.getMap('comments').set('t3', thread)
    thread.set('quote', 'again')
  })
  await x.client.flush()
  expect(bodies).toHaveLength(1)
  const plain = await decrypt(k.frameKey, bodies[0] as Uint8Array)
  expect(plain.subarray(0, fileDomain.length)).toEqual(fileDomain)
  expect(new DataView(plain.buffer, plain.byteOffset + fileDomain.length, 4).getUint32(0)).toBe(
    META,
  )
})

it('skips and counts unknown ids and updates of the wrong root', async () => {
  const k = await keys(),
    f = room1(),
    snapshot = await signed(k, bundleDomain, bundle(f.list))
  const extra = source()
  extra.getMap('extra').set('bad', true)
  const text = source()
  text.getText('content').insert(0, 'x')
  const entries: { id: number; body: string }[] = []
  for (const [id, update] of [
    [123, Y.encodeStateAsUpdate(f.comments)],
    [META, Y.encodeStateAsUpdate(extra)],
    [META, Y.encodeStateAsUpdate(text)],
    [0, Y.encodeStateAsUpdate(f.comments)],
  ] satisfies [number, Uint8Array][])
    entries.push({
      id: entries.length + 1,
      body: await signed(k, fileDomain, fileUpdate(id, update)),
    })
  const x = client(k, async () => read(snapshot, entries))
  await x.client.refresh()
  expect(x.client.state.skipped).toBe(4)
  expect(x.doc.getText('content').toString()).toBe('hello world')
})

it('counts only text files toward the 64-file cap', async () => {
  const k = await keys(),
    update = Y.encodeStateAsUpdate(source())
  const texts = Array.from({ length: 64 }, (_, id) => ({ id, path: `${id}.md`, update }))
  const metas = texts.map((t) => ({ id: META + t.id, path: metaPath(t.path), update }))
  const ok = client(k, async () =>
    read(await signed(k, bundleDomain, bundle([...texts, ...metas]))),
  )
  await ok.client.refresh()
  expect(ok.client.state.files).toHaveLength(128)
  const extra = { id: 64, path: '64.md', update }
  const over = client(k, async () => read(await signed(k, bundleDomain, bundle([...texts, extra]))))
  await expect(over.client.refresh()).rejects.toThrow()
})
