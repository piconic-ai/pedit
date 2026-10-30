import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { deriveRoomKeys, parseFragment, type RoomKeys } from '../src/access.ts'
import { decrypt, encrypt } from '../src/cipher.ts'
import { KeptTextClient } from '../src/kept-text.ts'

const domain = new TextEncoder().encode('pedit kept text v1\0')
const room = 'AAECAwQFBgcICQoLDA0ODw'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop()
})
const base64 = (value: Uint8Array) => {
  let text = ''
  for (let i = 0; i < value.length; i += 8192)
    text += String.fromCharCode(...value.subarray(i, i + 8192))
  return btoa(text)
}
async function keys() {
  const link = parseFragment('A'.repeat(43))
  if (!link) throw new Error('fixture link')
  return deriveRoomKeys(link, room)
}
async function signed(keys: RoomKeys, update: Uint8Array, prefix = domain): Promise<string> {
  if (!keys.signer) throw new Error('fixture signer')
  const message = new Uint8Array(prefix.length + update.length)
  message.set(prefix)
  message.set(update, prefix.length)
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.signer.key, message))
  const plain = new Uint8Array(message.length + 64)
  plain.set(message)
  plain.set(signature, message.length)
  return base64(await encrypt(keys.frameKey, plain))
}
function client(keys: RoomKeys, fetcher: typeof fetch) {
  const doc = new Y.Doc(),
    client = new KeptTextClient({
      origin: 'https://example.test',
      roomId: room,
      keys,
      doc,
      fetch: fetcher,
    })
  cleanup.push(() => {
    client.close()
    doc.destroy()
  })
  return { doc, client }
}
function source() {
  const doc = new Y.Doc()
  cleanup.push(() => doc.destroy())
  return doc
}
const read = (
  snapshot: string | undefined,
  entries: { id: number; body: string }[],
  cutoff = 0,
  tail = entries.at(-1)?.id ?? cutoff,
) => Response.json({ snapshot, entries, cutoff, tail, hostAway: true, keepUntil: 1234567890 })

const bundleDomain = new TextEncoder().encode('pedit kept files snapshot v1\0')
const fileDomain = new TextEncoder().encode('pedit kept file update v1\0')
const utf8 = new TextEncoder()
type File = { id: number; path: string; update: Uint8Array }
function bundle(files: File[]) {
  const value = new Uint8Array(
      2 + files.reduce((n, f) => n + 10 + utf8.encode(f.path).length + f.update.length, 0),
    ),
    view = new DataView(value.buffer)
  view.setUint16(0, files.length)
  let at = 2
  for (const file of files) {
    const path = utf8.encode(file.path)
    view.setUint32(at, file.id)
    at += 4
    view.setUint16(at, path.length)
    at += 2
    value.set(path, at)
    at += path.length
    view.setUint32(at, file.update.length)
    at += 4
    value.set(file.update, at)
    at += file.update.length
  }
  return value
}
function fileUpdate(id: number, update: Uint8Array) {
  const value = new Uint8Array(4 + update.length)
  new DataView(value.buffer).setUint32(0, id)
  value.set(update, 4)
  return value
}
function files() {
  const first = source(),
    second = source()
  first.getText('content').insert(0, 'one')
  second.getText('content').insert(0, 'two')
  return {
    first,
    second,
    list: [
      { id: 0, path: '日本語.md', update: Y.encodeStateAsUpdate(first) },
      { id: 7, path: 'nested/second.md', update: Y.encodeStateAsUpdate(second) },
    ],
  }
}
it('loads independent content-only documents and publishes the authenticated file list', async () => {
  const k = await keys(),
    f = files(),
    snapshot = await signed(k, bundle(f.list), bundleDomain)
  const x = client(k, async () => read(snapshot, []))
  expect(x.client.getDoc(0)).toBe(x.doc)
  expect(x.client.getDoc(7)).toBeUndefined()
  await x.client.refresh()
  expect(x.client.state.files).toEqual([
    { id: 0, path: '日本語.md', format: 'text' },
    { id: 7, path: 'nested/second.md', format: 'text' },
  ])
  expect(x.client.state.filename).toBe('日本語.md')
  const second = x.client.getDoc(7)
  expect(second?.getText('content').toString()).toBe('two')
  second?.getText('content').insert(3, ' local')
  expect(x.doc.getText('content').toString()).toBe('one')
})
it('retains per-file pending edits and exact ciphertext across an interrupted append', async () => {
  const k = await keys(),
    f = files(),
    snapshot = await signed(k, bundle(f.list), bundleDomain),
    bodies: Uint8Array[] = []
  const x = client(k, async (_, init) => {
    if (init?.method !== 'POST') return read(snapshot, [])
    bodies.push(new Uint8Array(await new Response(init.body).arrayBuffer()))
    if (bodies.length === 1) throw new Error('lost reply')
    return Response.json({})
  })
  await x.client.refresh()
  const second = x.client.getDoc(7)
  if (!second) throw new Error('missing second document')
  x.doc.getText('content').insert(3, ' A')
  second.getText('content').insert(3, ' B')
  x.doc.getText('content').insert(5, ' C')
  await expect(x.client.flush()).rejects.toThrow()
  second.getText('content').insert(5, ' D')
  await x.client.flush()
  expect(bodies).toHaveLength(5)
  expect(bodies[0]).toEqual(bodies[1])
  const ids = []
  for (const body of bodies) {
    const plain = await decrypt(k.frameKey, body)
    expect(plain.subarray(0, fileDomain.length)).toEqual(fileDomain)
    ids.push(new DataView(plain.buffer, plain.byteOffset + fileDomain.length, 4).getUint32(0))
  }
  expect(ids).toEqual([0, 0, 7, 0, 7])
  expect(second.getText('content').toString()).toBe('two B D')
  expect(x.doc.getText('content').toString()).toBe('one A C')
})
it('rejects invalid bundles and changed manifests before changing any document or metadata', async () => {
  const k = await keys(),
    f = files()
  let snapshot = await signed(k, bundle(f.list), bundleDomain)
  const x = client(k, async () => read(snapshot, []))
  await x.client.refresh()
  const original = x.client.state.files,
    second = x.client.getDoc(7)
  const extra = source()
  extra.getMap('extra').set('bad', true)
  const first = f.list[0],
    last = f.list[1]
  if (!first || !last) throw new Error('fixture list')
  const changed = source()
  changed.getText('content').insert(0, 'must not leak')
  const invalid = [
    [],
    [last, first],
    [first, { ...last, id: 0 }],
    [first, { ...last, path: '日本語.md' }],
    [first, { ...last, path: '../escape' }],
    [first, { ...last, path: 'renamed.md' }],
    [
      { ...first, update: Y.encodeStateAsUpdate(changed) },
      { ...last, update: Y.encodeStateAsUpdate(extra) },
    ],
  ]
  for (const list of invalid) {
    snapshot = await signed(k, bundle(list), bundleDomain)
    await expect(x.client.refresh()).rejects.toThrow()
    expect(x.client.state.files).toBe(original)
    expect(x.client.getDoc(7)).toBe(second)
    expect(x.doc.getText('content').toString()).toBe('one')
    expect(second?.getText('content').toString()).toBe('two')
  }
  snapshot = await signed(k, first.update)
  await expect(x.client.refresh()).rejects.toThrow()
  expect(x.client.state.files).toBe(original)
})
it('isolates invalid and unknown-file logs while resolving shuffled dependencies per file', async () => {
  const k = await keys(),
    first = source(),
    second = source(),
    empty = Y.encodeStateAsUpdate(first)
  const snapshot = await signed(
    k,
    bundle([
      { id: 0, path: 'a.md', update: empty },
      { id: 7, path: 'b.md', update: empty },
    ]),
    bundleDomain,
  )
  const updates: Uint8Array[] = []
  second.on('update', (update: Uint8Array) => updates.push(update))
  second.getText('content').insert(0, 'a')
  second.getText('content').insert(1, 'b')
  first.getText('content').insert(0, 'first')
  const a = updates[0],
    b = updates[1]
  if (!a || !b) throw new Error('fixture updates')
  const extra = source()
  extra.getMap('extra').set('bad', true)
  const entries: { id: number; body: string }[] = []
  for (const [id, update] of [
    [7, b],
    [123, a],
    [0, Y.encodeStateAsUpdate(first)],
    [7, Y.encodeStateAsUpdate(extra)],
    [7, a],
  ] satisfies [number, Uint8Array][])
    entries.push({
      id: entries.length + 1,
      body: await signed(k, fileUpdate(id, update), fileDomain),
    })
  entries.push({ id: entries.length + 1, body: snapshot })
  const x = client(k, async (input) =>
    Number(new URL(String(input)).searchParams.get('after')) === 0
      ? read(snapshot, entries)
      : read(undefined, [], 0, 6),
  )
  await x.client.refresh()
  expect(x.doc.getText('content').toString()).toBe('first')
  expect(x.client.getDoc(7)?.getText('content').toString()).toBe('ab')
  expect(x.client.state.skipped).toBe(3)
  await x.client.refresh()
  expect(x.client.state.skipped).toBe(3)
})
it('reloads a compacted multi-file checkpoint without replacing live documents or losing queued edits', async () => {
  const k = await keys(),
    f = files()
  let snapshot = await signed(k, bundle(f.list), bundleDomain),
    cutoff = 0
  const x = client(k, async () => read(snapshot, [], cutoff, cutoff))
  await x.client.refresh()
  const second = x.client.getDoc(7),
    original = x.client.state.files
  if (!second) throw new Error('fixture document')
  second.getText('content').insert(3, ' local')
  f.first.getText('content').insert(3, ' remote')
  f.list[0] = { id: 0, path: '日本語.md', update: Y.encodeStateAsUpdate(f.first) }
  snapshot = await signed(k, bundle(f.list), bundleDomain)
  cutoff = 2
  await x.client.refresh()
  expect(x.client.getDoc(7)).toBe(second)
  expect(x.client.state.files).toBe(original)
  expect(second.getText('content').toString()).toBe('two local')
  expect(x.doc.getText('content').toString()).toBe('one remote')
})
it('rejects truncated, oversized, non-UTF8 and trailing bundle payloads without publishing files', async () => {
  const k = await keys(),
    f = files(),
    valid = bundle(f.list)
  const nonUtf8 = Uint8Array.from(valid)
  nonUtf8[8] = 255
  const trailing = new Uint8Array(valid.length + 1)
  trailing.set(valid)
  const update = Y.encodeStateAsUpdate(source())
  const sixtyFive = Array.from({ length: 65 }, (_, id) => ({ id, path: `${id}.md`, update }))
  const large = source()
  large.getText('content').insert(0, 'x'.repeat(1024 * 1024))
  for (const payload of [
    valid.slice(0, -1),
    nonUtf8,
    trailing,
    bundle(sixtyFive),
    bundle([{ id: 0, path: 'large.md', update: Y.encodeStateAsUpdate(large) }]),
  ]) {
    const snapshot = await signed(k, payload, bundleDomain),
      x = client(k, async () => read(snapshot, []))
    await expect(x.client.refresh()).rejects.toThrow()
    expect(x.client.state.files).toEqual([])
    expect(x.client.getDoc(7)).toBeUndefined()
    expect(x.doc.getText('content').toString()).toBe('')
  }
})
it('keeps read links read-only across all documents and closes only owned nonzero documents', async () => {
  const k = await keys(),
    f = files(),
    snapshot = await signed(k, bundle(f.list), bundleDomain)
  const link = parseFragment(k.fragments.read ?? '')
  if (!link) throw new Error('fixture read link')
  const reader = await deriveRoomKeys(link, room)
  let posts = 0
  const x = client(reader, async (_, init) => {
    if (init?.method === 'POST') posts++
    return read(snapshot, [])
  })
  await x.client.refresh()
  const second = x.client.getDoc(7)
  if (!second) throw new Error('fixture file')
  second.getText('content').insert(3, ' forbidden')
  await expect(x.client.flush()).rejects.toThrow()
  expect(posts).toBe(0)
  let rootDestroyed = false,
    secondDestroyed = false
  x.doc.on('destroy', () => {
    rootDestroyed = true
  })
  second.on('destroy', () => {
    secondDestroyed = true
  })
  x.client.close()
  expect(rootDestroyed).toBe(false)
  expect(secondDestroyed).toBe(true)
})
