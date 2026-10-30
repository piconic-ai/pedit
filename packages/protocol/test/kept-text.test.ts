import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { deriveRoomKeys, parseFragment, type RoomKeys } from '../src/access.ts'
import { encrypt } from '../src/cipher.ts'
import { MAX_FRAME_BYTES } from '../src/frame.ts'
import { KeptTextClient, KeptTextClosedError } from '../src/kept-text.ts'

const room = 'AAECAwQFBgcICQoLDA0ODw'
const origin = 'https://example.test'
const domain = new TextEncoder().encode('pedit kept text v1\0')
const opened: { client: KeptTextClient; doc: Y.Doc }[] = []
afterEach(() => {
  for (const { client, doc } of opened.splice(0)) {
    client.close()
    doc.destroy()
  }
})
async function roomKeys() {
  const link = parseFragment('A'.repeat(43))
  if (!link) throw new Error('fixture link')
  return deriveRoomKeys(link, room)
}
async function signed(keys: RoomKeys, update: Uint8Array): Promise<string> {
  const message = new Uint8Array(domain.length + update.length)
  message.set(domain)
  message.set(update, domain.length)
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.signer!.key, message))
  const plain = new Uint8Array(message.length + signature.length)
  plain.set(message)
  plain.set(signature, message.length)
  const ciphertext = await encrypt(keys.frameKey, plain)
  return btoa(String.fromCharCode(...ciphertext))
}
async function setup() {
  const keys = await roomKeys()
  const source = new Y.Doc()
  source.getText('content').insert(0, 'hello')
  const snapshot = await signed(keys, Y.encodeStateAsUpdate(source))
  const entries: { id: number; body: string }[] = []
  const requests: { url: string; init?: RequestInit }[] = []
  let lost = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    expect(init?.redirect).toBe('manual')
    expect(new Headers(init?.headers).get('X-Pedit-Admission')).toBe(keys.editAdmission)
    expect(url).not.toContain('#')
    if (init?.method === 'POST') {
      if (!(init.body instanceof Uint8Array)) throw new Error('binary body required')
      const body = btoa(String.fromCharCode(...Uint8Array.from(init.body)))
      if (!entries.some((entry) => entry.body === body))
        entries.push({ id: entries.length + 1, body })
      if (!lost) {
        lost = true
        throw new Error('lost response including secret that must not escape')
      }
      return Response.json({ id: entries.length })
    }
    const after = Number(new URL(url).searchParams.get('after') ?? 0)
    return Response.json({
      snapshot: after === 0 ? snapshot : undefined,
      entries: entries.filter((entry) => entry.id > after),
      cutoff: 0,
      tail: entries.length,
      hostAway: true,
      keepUntil: 1234567890,
    })
  }
  const doc = new Y.Doc(),
    statuses: string[] = []
  const client = new KeptTextClient({
    origin,
    roomId: room,
    keys,
    doc,
    fetch: fetcher,
    onStatus: (status) => statuses.push(status),
  })
  opened.push({ client, doc })
  return { keys, source, entries, requests, fetcher, doc, client, statuses, snapshot }
}

it('loads signed text without enqueueing, preserves exact ciphertext after a lost response, and tolerates replay', async () => {
  const x = await setup()
  try {
    await x.client.refresh()
    expect(x.doc.getText('content').toString()).toBe('hello')
    await x.client.flush()
    expect(x.requests.filter((request) => request.init?.method === 'POST')).toHaveLength(0)
    x.doc.getText('content').insert(5, ' guest')
    await expect(x.client.flush()).rejects.toThrow('kept text operation failed')
    expect(x.statuses.at(-1)).toBe('failed')
    await x.client.flush()
    const sent = x.requests.filter((request) => request.init?.method === 'POST')
    expect(sent).toHaveLength(2)
    expect(sent[0]?.init?.body).toEqual(sent[1]?.init?.body)
    const sender = new Headers(sent[0]?.init?.headers).get('X-Pedit-Sender')
    expect(sender).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Headers(sent[1]?.init?.headers).get('X-Pedit-Sender')).toBe(sender)
    expect(x.statuses.at(-1)).toBe('kept')
    await x.client.refresh()
    await x.client.refresh()
    expect(x.doc.getText('content').toString()).toBe('hello guest')
    expect(x.client.state).toEqual({
      hostAway: true,
      keepUntil: 1234567890,
      logEntries: 1,
      skipped: 0,
      after: 1,
      filename: null,
    })
  } finally {
    x.source.destroy()
  }
})

it('skips commenter signatures but rejects malformed read metadata before importing state', async () => {
  const x = await setup()
  try {
    const fragment = x.keys.fragments.comment
    const link = fragment && parseFragment(fragment)
    if (!link) throw new Error('comment fixture')
    const comment = await deriveRoomKeys(link, room)
    const forged = await signed(comment, Y.encodeStateAsUpdate(x.source))
    for (const entry of [
      { id: 1, body: forged },
      { id: 0, body: x.snapshot },
      { id: 2, body: x.snapshot },
    ]) {
      const doc = new Y.Doc()
      const client = new KeptTextClient({
        origin,
        roomId: room,
        keys: x.keys,
        doc,
        fetch: async () =>
          Response.json({
            snapshot: x.snapshot,
            entries: [entry],
            cutoff: 0,
            tail: 1,
            hostAway: true,
            keepUntil: 1,
          }),
      })
      opened.push({ client, doc })
      if (entry.id === 1) {
        await client.refresh()
        expect(doc.getText('content').toString()).toBe('hello')
        expect(client.state.skipped).toBe(1)
      } else {
        await expect(client.refresh()).rejects.toThrow()
        expect(doc.getText('content').toString()).toBe('')
      }
    }
  } finally {
    x.source.destroy()
  }
})

it('read and comment links never append text and use only their reader admission', async () => {
  const edit = await roomKeys(),
    source = new Y.Doc()
  source.getText('content').insert(0, 'hello')
  const snapshot = await signed(edit, Y.encodeStateAsUpdate(source))
  source.destroy()
  for (const access of ['read', 'comment'] as const) {
    const fragment = edit.fragments[access],
      link = fragment && parseFragment(fragment)
    if (!link) throw new Error('fixture lower link')
    const keys = await deriveRoomKeys(link, room),
      doc = new Y.Doc()
    const fetcher = vi.fn<typeof fetch>(async (_, init) => {
      expect(init?.method).toBe('GET')
      expect(new Headers(init?.headers).get('X-Pedit-Admission')).toBe(keys.readAdmission)
      return Response.json({
        snapshot,
        entries: [],
        cutoff: 0,
        tail: 0,
        hostAway: true,
        keepUntil: 1,
      })
    })
    const client = new KeptTextClient({ origin, roomId: room, keys, doc, fetch: fetcher })
    opened.push({ client, doc })
    await client.refresh()
    expect(doc.getText('content').toString()).toBe('hello')
    doc.getText('content').insert(0, 'not shared')
    await expect(client.flush()).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  }
})

it('rejects oversized streams, oversized frames, redirects and invalid metadata', async () => {
  const x = await setup()
  try {
    const invalid = [
      new Response(new Uint8Array(8 * 1024 * 1024 + 1)),
      Response.json({
        snapshot: 'A'.repeat(Math.ceil((MAX_FRAME_BYTES + 1) / 3) * 4),
        entries: [],
        cutoff: 0,
        tail: 0,
        hostAway: true,
        keepUntil: 1,
      }),
      new Response(null, { status: 302, headers: { Location: 'https://attacker.test' } }),
      Response.json({
        snapshot: x.snapshot,
        entries: [],
        cutoff: 0,
        tail: -1,
        hostAway: true,
        keepUntil: 1,
      }),
    ]
    for (const response of invalid) {
      const doc = new Y.Doc(),
        client = new KeptTextClient({
          origin,
          roomId: room,
          keys: x.keys,
          doc,
          fetch: async () => response,
        })
      opened.push({ client, doc })
      await expect(client.refresh()).rejects.toThrow()
      expect(doc.getText('content').toString()).toBe('')
    }
  } finally {
    x.source.destroy()
  }
})

it('serializes refresh with an edit and a queued flush without reenqueueing imported text', async () => {
  const x = await setup()
  let release!: () => void, started!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const doc = new Y.Doc()
  const client = new KeptTextClient({
    origin,
    roomId: room,
    keys: x.keys,
    doc,
    fetch: async (input, init) => {
      if (init?.method === 'GET') {
        started()
        await gate
      }
      return x.fetcher(input, init)
    },
  })
  opened.push({ client, doc })
  try {
    const refresh = client.refresh()
    await entered
    doc.getText('content').insert(0, ' local')
    const flush = client.flush()
    release()
    await refresh
    await expect(flush).rejects.toThrow()
    await client.flush()
    const posts = x.requests.filter((request) => request.init?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0]?.init?.body).toEqual(posts[1]?.init?.body)
    expect(doc.getText('content').toString()).toContain('hello')
    expect(doc.getText('content').toString()).toContain(' local')
  } finally {
    x.source.destroy()
  }
})

it('keeps refusing an oversized local update on retry without issuing an append', async () => {
  const keys = await roomKeys(),
    doc = new Y.Doc(),
    fetcher = vi.fn<typeof fetch>()
  const client = new KeptTextClient({ origin, roomId: room, keys, doc, fetch: fetcher })
  opened.push({ client, doc })
  doc.getText('content').insert(0, 'x'.repeat(MAX_FRAME_BYTES))
  await expect(client.flush()).rejects.toThrow()
  await expect(client.flush()).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

it('reports expiry distinctly so the editor can stop retrying a closed room', async () => {
  const keys = await roomKeys(),
    doc = new Y.Doc()
  const client = new KeptTextClient({
    origin,
    roomId: room,
    keys,
    doc,
    fetch: async () => new Response(null, { status: 410 }),
  })
  opened.push({ client, doc })
  await expect(client.refresh()).rejects.toBeInstanceOf(KeptTextClosedError)
})
