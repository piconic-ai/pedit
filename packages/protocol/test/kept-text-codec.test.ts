import { expect, it } from 'vitest'
import * as Y from 'yjs'
import { deriveRoomKeys, parseFragment, type RoomKeys } from '../src/access.ts'
import { decrypt, encrypt } from '../src/cipher.ts'
import {
  declare,
  decodeSnapshot,
  decodeUpdate,
  incomplete,
  kindOf,
  mergeSnapshot,
  openKeptFrame,
  probeEntries,
  sealKeptUpdate,
  trial,
} from '../src/kept-text.ts'

const utf8 = new TextEncoder()
const domain = utf8.encode('pedit kept text v1\0')
const snapshotDomain = utf8.encode('pedit kept snapshot v1\0')
const bundleDomain = utf8.encode('pedit kept files snapshot v1\0')
const room = 'AAECAwQFBgcICQoLDA0ODw'

async function keys(): Promise<RoomKeys> {
  const link = parseFragment('A'.repeat(43))
  if (!link) throw new Error('fixture link')
  return deriveRoomKeys(link, room)
}

/** Signs and encrypts `payload` under `prefix`, as a host or an editor would. */
async function signed(keys: RoomKeys, payload: Uint8Array, prefix = domain): Promise<Uint8Array> {
  if (!keys.signer) throw new Error('fixture signer')
  const message = new Uint8Array(prefix.length + payload.length)
  message.set(prefix)
  message.set(payload, prefix.length)
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.signer.key, message))
  const plain = new Uint8Array(message.length + 64)
  plain.set(message)
  plain.set(signature, message.length)
  return encrypt(keys.frameKey, plain)
}

const open = async (k: RoomKeys, ciphertext: Uint8Array) =>
  decodeSnapshot(await openKeptFrame(k, ciphertext))

function docWith(text: string) {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return doc
}

function named(name: Uint8Array, update: Uint8Array) {
  const value = new Uint8Array(2 + name.length + update.length)
  new DataView(value.buffer).setUint16(0, name.length)
  value.set(name, 2)
  value.set(update, 2 + name.length)
  return value
}

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

it('reads a signed Unicode filename and an update without one', async () => {
  const k = await keys(),
    update = Y.encodeStateAsUpdate(docWith('hello'))
  const unicode = await open(
    k,
    await signed(k, named(utf8.encode('日本語.md'), update), snapshotDomain),
  )
  expect(unicode).toMatchObject({ kind: 'legacy', filename: '日本語.md' })
  const longest = await open(
    k,
    await signed(k, named(utf8.encode('x'.repeat(4096)), update), snapshotDomain),
  )
  expect(longest).toMatchObject({ kind: 'legacy', filename: 'x'.repeat(4096) })
  const bare = decodeUpdate(await openKeptFrame(k, await signed(k, update)))
  expect(bare.id).toBe(0)
})

it('rejects malformed authenticated filename metadata', async () => {
  const k = await keys(),
    update = Y.encodeStateAsUpdate(docWith('safe'))
  const names = ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(4097)]
  const malformed = names.map((name) => named(utf8.encode(name), update))
  malformed.push(
    named(Uint8Array.of(0xff), update),
    Uint8Array.of(0, 10, 65),
    named(utf8.encode('name'), new Uint8Array()),
  )
  for (const value of malformed)
    await expect(open(k, await signed(k, value, snapshotDomain))).rejects.toThrow()
})

it('rejects tampered and wrong-domain snapshots and does not read an envelope as an update', async () => {
  const k = await keys(),
    update = Y.encodeStateAsUpdate(docWith('safe')),
    envelope = await signed(k, named(utf8.encode('safe.md'), update), snapshotDomain)
  const tampered = Uint8Array.from(envelope)
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1
  // Changing the name without signing it again.
  const modified = await decrypt(k.frameKey, envelope)
  modified[snapshotDomain.length + 2] = 88
  const unsigned = await encrypt(k.frameKey, modified)
  await expect(open(k, tampered)).rejects.toThrow()
  await expect(open(k, unsigned)).rejects.toThrow()
  await expect(open(k, await signed(k, update, utf8.encode('wrong')))).rejects.toThrow()
  expect(() => decodeUpdate(new Uint8Array())).toThrow()
  expect(() => decodeUpdate(snapshotDomain)).toThrow()
})

it('reads a file bundle and rejects invalid ones', async () => {
  const k = await keys(),
    a = Y.encodeStateAsUpdate(docWith('one')),
    b = Y.encodeStateAsUpdate(docWith('two'))
  const first = { id: 0, path: '日本語.md', update: a },
    last = { id: 7, path: 'nested/second.md', update: b }
  const opened = await open(k, await signed(k, bundle([first, last]), bundleDomain))
  if (opened.kind !== 'bundle') throw new Error('expected a bundle')
  expect(opened.files.map((f) => [f.id, f.path])).toEqual([
    [0, '日本語.md'],
    [7, 'nested/second.md'],
  ])

  const valid = bundle([first, last])
  const nonUtf8 = Uint8Array.from(valid)
  nonUtf8[8] = 255
  const trailing = new Uint8Array(valid.length + 1)
  trailing.set(valid)
  const sixtyFive = Array.from({ length: 65 }, (_, id) => ({ id, path: `${id}.md`, update: a }))
  for (const payload of [
    bundle([]),
    bundle([last, first]),
    bundle([first, { ...last, id: 0 }]),
    bundle([first, { ...last, path: '日本語.md' }]),
    bundle([first, { ...last, path: '../escape' }]),
    valid.slice(0, -1),
    nonUtf8,
    trailing,
    bundle(sixtyFive),
  ])
    await expect(open(k, await signed(k, payload, bundleDomain))).rejects.toThrow()
})

it('skips invalid entries and drops ones whose dependencies never arrive', () => {
  const host = new Y.Doc(),
    updates: Uint8Array[] = []
  host.on('update', (u: Uint8Array) => updates.push(u))
  const text = host.getText('content')
  text.insert(0, 'a')
  text.insert(1, 'b')
  text.insert(2, 'c')
  const [first, second, third] = updates
  if (!first || !second || !third) throw new Error('fixture updates')
  const base = new Y.Doc()
  // Shuffled dependencies resolve; garbage is skipped and counted once.
  const shuffled = probeEntries(base, [third, Uint8Array.of(255), second, first])
  expect(shuffled.skipped).toBe(1)
  expect(shuffled.doc.getText('content').toString()).toBe('abc')
  expect(incomplete(shuffled.doc)).toBe(false)
  // An update missing its dependency is dropped without poisoning the rest.
  const dropped = probeEntries(base, [third, first])
  expect(dropped.skipped).toBe(1)
  expect(dropped.doc.getText('content').toString()).toBe('a')
  // A probe never changes its base.
  expect(base.getText('content').toString()).toBe('')
})

it('rejects an update with a second root, and merges a snapshot', () => {
  const base = docWith('safe')
  const extra = new Y.Doc()
  extra.getMap('extra').set('bad', true)
  expect(() => trial(base, Y.encodeStateAsUpdate(extra))).toThrow()
  expect(() => trial(base, Uint8Array.of(255))).toThrow()
  expect(base.getText('content').toString()).toBe('safe')

  const target = new Y.Doc()
  mergeSnapshot(target, Y.encodeStateAsUpdate(base))
  expect(target.getText('content').toString()).toBe('safe')
})

it('tells a text doc from a comments doc and seals an update that opens again', async () => {
  const k = await keys()
  expect(kindOf(declare(new Y.Doc(), true))).toBe('comments')
  expect(kindOf(declare(new Y.Doc(), false))).toBe('content')
  const update = Y.encodeStateAsUpdate(docWith('sealed'))
  const sealed = await sealKeptUpdate(k, 3, update)
  expect(decodeUpdate(await openKeptFrame(k, sealed))).toEqual({ id: 3, update })
})
