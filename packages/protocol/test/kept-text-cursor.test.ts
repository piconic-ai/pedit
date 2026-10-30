import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { deriveRoomKeys, parseFragment, type RoomKeys } from '../src/access.ts'
import { decrypt, encrypt } from '../src/cipher.ts'
import { MAX_FRAME_BYTES } from '../src/frame.ts'
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

it('skips invalid individual records between valid edits, counting each ID only once', async () => {
  const k = await keys(),
    host = source()
  host.getText('content').insert(0, 'base')
  const snapshot = await signed(k, Y.encodeStateAsUpdate(host))
  const updates: Uint8Array[] = []
  host.on('update', (update: Uint8Array) => updates.push(update))
  host.getText('content').insert(4, ' first')
  host.getText('content').insert(10, ' second')
  const first = updates[0],
    second = updates[1]
  if (!first || !second) throw new Error('fixture updates')
  const commentLink = parseFragment(k.fragments.comment ?? '')
  if (!commentLink) throw new Error('fixture comment link')
  const commenter = await deriveRoomKeys(commentLink, room)
  const entries = [
    { id: 1, body: await signed(k, first) },
    { id: 2, body: base64(Uint8Array.of(1, 2, 3)) },
    { id: 3, body: await signed(k, first, new TextEncoder().encode('wrong domain')) },
    { id: 4, body: await signed(commenter, first) },
    { id: 5, body: await signed(k, Uint8Array.of(255)) },
    { id: 6, body: await signed(k, second) },
  ]
  const after: number[] = []
  const x = client(k, async (input) => {
    const cursor = Number(new URL(String(input)).searchParams.get('after') ?? 0)
    after.push(cursor)
    return read(
      cursor === 0 ? snapshot : undefined,
      entries.filter((entry) => entry.id > cursor),
      0,
      6,
    )
  })
  await x.client.refresh()
  expect(x.doc.getText('content').toString()).toBe('base first second')
  expect(x.client.state.skipped).toBe(4)
  await x.client.refresh()
  expect(after).toEqual([0, 6])
  expect(x.client.state.skipped).toBe(4)
})
it('allows valid dependencies to complete later in the same response and drops unresolved records without poisoning later text', async () => {
  const k = await keys(),
    host = source(),
    updates: Uint8Array[] = []
  const snapshot = await signed(k, Y.encodeStateAsUpdate(host))
  host.on('update', (update: Uint8Array) => updates.push(update))
  host.getText('content').insert(0, 'a')
  host.getText('content').insert(1, 'b')
  const a = updates[0],
    b = updates[1]
  if (!a || !b) throw new Error('fixture updates')
  const other = source(),
    dangling: Uint8Array[] = []
  other.on('update', (update: Uint8Array) => dangling.push(update))
  other.getText('content').insert(0, 'missing')
  other.getText('content').insert(7, 'dependency')
  const pending = dangling[1]
  if (!pending) throw new Error('fixture dependency')
  const entries = [
    { id: 1, body: await signed(k, b) },
    { id: 2, body: await signed(k, pending) },
    { id: 3, body: await signed(k, a) },
  ]
  const x = client(k, async () => read(snapshot, entries))
  await x.client.refresh()
  expect(x.doc.getText('content').toString()).toBe('ab')
  expect(x.client.state.skipped).toBe(1)
  expect(x.doc.store.pendingStructs).toBeNull()
  expect(x.doc.store.pendingDs).toBeNull()
})
it('merges 2000 single-character updates into one signed append', async () => {
  const k = await keys(),
    bodies: Uint8Array[] = []
  const x = client(k, async (_, init) => {
    if (!(init?.body instanceof Uint8Array)) throw new Error('append body')
    bodies.push(Uint8Array.from(init.body))
    return Response.json({})
  })
  for (let i = 0; i < 2000; i++) x.doc.getText('content').insert(i, 'x')
  await x.client.flush()
  expect(bodies).toHaveLength(1)
  const body = bodies[0]
  if (!body) throw new Error('missing append')
  const plain = await decrypt(k.frameKey, body),
    relay = source()
  Y.applyUpdate(relay, plain.subarray(domain.length, plain.length - 64))
  expect(relay.getText('content').toString()).toBe('x'.repeat(2000))
})
it('uses the largest fitting ordered prefixes and preserves the prepared body when new input arrives after a lost response', async () => {
  const k = await keys(),
    bodies: Uint8Array[] = []
  let failed = false
  const x = client(k, async (_, init) => {
    if (!(init?.body instanceof Uint8Array)) throw new Error('append body')
    bodies.push(Uint8Array.from(init.body))
    if (!failed) {
      failed = true
      throw new Error('lost response')
    }
    return Response.json({})
  })
  for (let i = 0; i < 4; i++) x.doc.getText('content').insert(i * 300000, 'x'.repeat(300000))
  await expect(x.client.flush()).rejects.toThrow()
  x.doc.getText('content').insert(1200000, 'tail')
  await x.client.flush()
  expect(bodies).toHaveLength(3)
  expect(bodies[0]).toEqual(bodies[1])
  const relay = source()
  for (const body of bodies.slice(1)) {
    expect(body.length).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    const plain = await decrypt(k.frameKey, body)
    Y.applyUpdate(relay, plain.subarray(domain.length, plain.length - 64))
  }
  expect(relay.getText('content').toString()).toBe('x'.repeat(1200000) + 'tail')
})
it('retains updates arriving during signing for a later flush without claiming they are kept', async () => {
  const k = await keys(),
    bodies: Uint8Array[] = [],
    statuses: string[] = []
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  const doc = source(),
    c = new KeptTextClient({
      origin: 'https://example.test',
      roomId: room,
      keys: k,
      doc,
      onStatus: (status) => statuses.push(status),
      fetch: async (_, init) => {
        if (!(init?.body instanceof Uint8Array)) throw new Error('append body')
        bodies.push(Uint8Array.from(init.body))
        entered()
        await gate
        return Response.json({})
      },
    })
  cleanup.push(() => c.close())
  doc.getText('content').insert(0, 'first')
  const flushing = c.flush()
  await started
  doc.getText('content').insert(5, ' second')
  release()
  await flushing
  expect(bodies).toHaveLength(1)
  expect(statuses.at(-1)).toBe('pending')
  await c.flush()
  expect(bodies).toHaveLength(2)
  expect(statuses.at(-1)).toBe('kept')
})
it('uses cursor deltas, reloads a newer cutoff snapshot, and accepts only a matching304 with metadata', async () => {
  const k = await keys(),
    host = source()
  host.getText('content').insert(0, 'one')
  const first = await signed(k, Y.encodeStateAsUpdate(host))
  host.getText('content').insert(3, ' two')
  const second = await signed(k, Y.encodeStateAsUpdate(host))
  const calls: { after: number; etag: string | null }[] = []
  let n = 0
  const x = client(k, async (input, init) => {
    calls.push({
      after: Number(new URL(String(input)).searchParams.get('after')),
      etag: new Headers(init?.headers).get('If-None-Match'),
    })
    if (++n === 1) {
      const r = read(first, [], 0, 0)
      r.headers.set('ETag', '"one-0"')
      return r
    }
    if (n === 2)
      return new Response(null, {
        status: 304,
        headers: {
          ETag: '"one-0"',
          'X-Pedit-Cutoff': '0',
          'X-Pedit-Tail': '0',
          'X-Pedit-Host-Away': 'false',
          'X-Pedit-Keep-Until': '2345678901',
        },
      })
    if (n === 3) {
      const r = read(second, [], 2, 2)
      r.headers.set('ETag', '"two-2"')
      return r
    }
    return read(undefined, [], 2, 2)
  })
  await x.client.refresh()
  await x.client.refresh()
  expect(x.client.state.hostAway).toBe(false)
  expect(x.client.state.keepUntil).toBe(2345678901)
  await x.client.refresh()
  await x.client.refresh()
  expect(x.doc.getText('content').toString()).toBe('one two')
  expect(calls).toEqual([
    { after: 0, etag: null },
    { after: 0, etag: '"one-0"' },
    { after: 0, etag: '"one-0"' },
    { after: 2, etag: '"two-2"' },
  ])
})
it('treats an invalid snapshot as fatal without advancing the cursor or importing entries', async () => {
  const k = await keys(),
    host = source()
  host.getText('content').insert(0, 'valid')
  const entry = await signed(k, Y.encodeStateAsUpdate(host))
  const x = client(k, async () => read('bad snapshot', [{ id: 1, body: entry }]))
  await expect(x.client.refresh()).rejects.toThrow()
  expect(x.doc.getText('content').toString()).toBe('')
  expect(x.client.state.skipped).toBe(0)
})

it('discards a partially applied frame without leaking its changes into later valid edits', async () => {
  const k = await keys(),
    host = source()
  host.getText('content').insert(0, 'base')
  const snapshot = await signed(k, Y.encodeStateAsUpdate(host)),
    bad = source()
  Y.applyUpdate(bad, Y.encodeStateAsUpdate(host))
  bad.getText('content').insert(4, ' poison')
  const corrupt = Y.encodeStateAsUpdate(bad),
    trailing = new Uint8Array(corrupt.length + 1)
  trailing.set(corrupt)
  trailing[corrupt.length] = 255
  host.getText('content').insert(4, ' valid')
  const x = client(k, async () =>
    read(snapshot, [
      { id: 1, body: await signed(k, trailing) },
      { id: 2, body: await signed(k, Y.encodeStateAsUpdate(host)) },
    ]),
  )
  await x.client.refresh()
  expect(x.doc.getText('content').toString()).toBe('base valid')
  expect(x.client.state.skipped).toBe(1)
})
it('rejects304 before initial load and malformed cached metadata without changing the cursor', async () => {
  const k = await keys(),
    host = source(),
    snapshot = await signed(k, Y.encodeStateAsUpdate(host))
  const bad = client(k, async () => new Response(null, { status: 304 }))
  await expect(bad.client.refresh()).rejects.toThrow()
  for (const fields of [
    { 'X-Pedit-Tail': '1' },
    { 'X-Pedit-Cutoff': '' },
    { 'X-Pedit-Host-Away': 'maybe' },
    { ETag: '"wrong"' },
  ]) {
    let calls = 0
    const x = client(k, async () => {
      if (++calls === 1) {
        const r = read(snapshot, [])
        r.headers.set('ETag', '"known"')
        return r
      }
      return new Response(null, {
        status: 304,
        headers: {
          ETag: '"known"',
          'X-Pedit-Cutoff': '0',
          'X-Pedit-Tail': '0',
          'X-Pedit-Host-Away': 'true',
          'X-Pedit-Keep-Until': '1234567890',
          ...fields,
        },
      })
    })
    await x.client.refresh()
    await expect(x.client.refresh()).rejects.toThrow()
    expect(x.client.state.after).toBe(0)
  }
})
