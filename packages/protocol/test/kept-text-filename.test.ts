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

const snapshotDomain = new TextEncoder().encode('pedit kept snapshot v1\0')
function payload(name: Uint8Array, update: Uint8Array) {
  const value = new Uint8Array(2 + name.length + update.length)
  new DataView(value.buffer).setUint16(0, name.length)
  value.set(name, 2)
  value.set(update, 2 + name.length)
  return value
}
it('loads a signed Unicode filename, retains it through delta/304, and updates it on cutoff reload', async () => {
  const k = await keys(),
    host = source()
  host.getText('content').insert(0, 'hello')
  const update = Y.encodeStateAsUpdate(host),
    encode = (name: string) =>
      signed(k, payload(new TextEncoder().encode(name), update), snapshotDomain)
  const initial = await encode('日本語😀.md'),
    renamed = await encode('次.md')
  let call = 0
  const x = client(k, async () => {
    call++
    if (call === 2)
      return new Response(null, {
        status: 304,
        headers: {
          ETag: '"one"',
          'X-Pedit-Cutoff': '0',
          'X-Pedit-Tail': '0',
          'X-Pedit-Host-Away': 'true',
          'X-Pedit-Keep-Until': '1234567890',
        },
      })
    if (call === 3) return read(undefined, [], 0, 1)
    if (call === 4) return read(renamed, [], 2, 2)
    const response = read(initial, [])
    response.headers.set('ETag', '"one"')
    return response
  })
  await x.client.refresh()
  expect(x.client.state.filename).toBe('日本語😀.md')
  await x.client.refresh()
  await x.client.refresh()
  expect(x.client.state.filename).toBe('日本語😀.md')
  await x.client.refresh()
  expect(x.client.state.filename).toBe('次.md')
  expect(x.doc.getText('content').toString()).toBe('hello')
})
it('keeps legacy snapshots readable without a filename', async () => {
  const k = await keys(),
    host = source()
  host.getText('content').insert(0, 'legacy')
  const x = client(k, async () => read(await signed(k, Y.encodeStateAsUpdate(host)), []))
  await x.client.refresh()
  expect(x.client.state.filename).toBe(null)
  expect(x.doc.getText('content').toString()).toBe('legacy')
})
it('rejects malformed authenticated filename metadata atomically', async () => {
  const k = await keys(),
    host = source()
  host.getText('content').insert(0, 'safe')
  const update = Y.encodeStateAsUpdate(host),
    valid = await signed(k, payload(new TextEncoder().encode('safe.md'), update), snapshotDomain)
  let current = valid
  const x = client(k, async () => read(current, []))
  await x.client.refresh()
  const names = ['', '.', '..', 'a/b', 'a\\b', 'a\0b', 'x'.repeat(4097)]
  const malformed = names.map((name) => payload(new TextEncoder().encode(name), update))
  malformed.push(
    payload(Uint8Array.of(0xff), update),
    Uint8Array.of(0, 10, 65),
    payload(new TextEncoder().encode('name'), new Uint8Array()),
    payload(new TextEncoder().encode('name'), Uint8Array.of(255)),
  )
  for (const value of malformed) {
    current = await signed(k, value, snapshotDomain)
    await expect(x.client.refresh()).rejects.toThrow()
    expect(x.client.state.filename).toBe('safe.md')
    expect(x.doc.getText('content').toString()).toBe('safe')
  }
  current = await signed(
    k,
    payload(new TextEncoder().encode('x'.repeat(4096)), update),
    snapshotDomain,
  )
  await x.client.refresh()
  expect(x.client.state.filename).toHaveLength(4096)
})
it('rejects tampered and wrong-domain snapshots and never imports snapshot envelopes as log updates', async () => {
  const k = await keys(),
    host = source()
  host.getText('content').insert(0, 'safe')
  const update = Y.encodeStateAsUpdate(host),
    envelope = await signed(k, payload(new TextEncoder().encode('safe.md'), update), snapshotDomain)
  const tampered = Uint8Array.from(atob(envelope), (c) => c.charCodeAt(0))
  const last = tampered.at(-1)
  if (last === undefined) throw new Error('fixture ciphertext')
  tampered[tampered.length - 1] = last ^ 1
  const modified = await decrypt(
    k.frameKey,
    Uint8Array.from(atob(envelope), (c) => c.charCodeAt(0)),
  )
  modified[snapshotDomain.length + 2] = 88
  const changedNameWithoutSignature = base64(await encrypt(k.frameKey, modified))
  for (const snapshot of [
    base64(tampered),
    changedNameWithoutSignature,
    await signed(k, update, new TextEncoder().encode('wrong')),
  ]) {
    const x = client(k, async () => read(snapshot, []))
    await expect(x.client.refresh()).rejects.toThrow()
    expect(x.client.state.filename).toBe(null)
    expect(x.doc.getText('content').toString()).toBe('')
  }
  const x = client(k, async () => read(await signed(k, update), [{ id: 1, body: envelope }]))
  await x.client.refresh()
  expect(x.client.state.skipped).toBe(1)
  expect(x.client.state.filename).toBe(null)
  expect(x.doc.getText('content').toString()).toBe('safe')
})
