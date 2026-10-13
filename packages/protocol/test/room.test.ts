import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  type Attachment,
  type CanvasMessage,
  CLIENT_OUTDATED,
  encrypt,
  generateKey,
  importKey,
  MAX_FRAME_BYTES,
  MessageType,
  RELAY_MAINTENANCE,
  RoomClient,
  SERVER_OUTDATED,
} from '../src/index.ts'
import { Relay } from '../src/testing.ts'

const clients: RoomClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.destroy()
})

async function join(
  relay: Relay,
  key: CryptoKey,
  init?: string,
  state?: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  const doc = new Y.Doc()
  if (init) doc.getText('content').insert(0, init)
  const awareness = new Awareness(doc)
  if (state) awareness.setLocalState(state)
  const client = new RoomClient({
    admissionToken: 'A'.repeat(43),
    url: 'ws://test',
    key,
    doc,
    awareness,
    headers,
    createSocket: relay.create,
  })
  clients.push(client)
  client.connect()
  return client
}

const text = (c: RoomClient) => c.doc.getText('content').toString()

describe('RoomClient', () => {
  it('gives a late joiner the full document', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = await join(relay, key, '# notes\n')
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const guest = await join(relay, key)
    await vi.waitFor(() => expect(text(guest)).toBe('# notes\n'))
  })

  it('syncs concurrent edits both ways', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const a = await join(relay, key, 'hello')
    const b = await join(relay, key)
    await vi.waitFor(() => expect(text(b)).toBe('hello'))
    a.doc.getText('content').insert(0, 'A')
    b.doc.getText('content').insert(5, 'B')
    await vi.waitFor(() => {
      expect(text(a)).toBe(text(b))
      expect(text(a)).toContain('A')
      expect(text(a)).toContain('B')
    })
  })

  it('pushes offline edits of a reconnecting host', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const guest = await join(relay, key)
    await join(relay, key, 'written before anyone joined')
    await vi.waitFor(() => expect(text(guest)).toBe('written before anyone joined'))
  })

  it('shares awareness with newcomers and clears it on leave', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = await join(relay, key, '', { role: 'host' })
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const guest = await join(relay, key, '', { name: 'guest' })
    await vi.waitFor(() => {
      expect(guest.awareness.getStates().get(host.doc.clientID)).toEqual({ role: 'host' })
      expect(host.awareness.getStates().get(guest.doc.clientID)).toEqual({ name: 'guest' })
    })
    await host.destroy()
    await vi.waitFor(() => expect(guest.awareness.getStates().has(host.doc.clientID)).toBe(false))
  })

  it('sends only ciphertext over the wire', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    await join(relay, key, 'top secret plaintext')
    const b = await join(relay, key)
    await vi.waitFor(() => expect(text(b)).toBe('top secret plaintext'))
    const wire = relay.frames.map((f) => new TextDecoder().decode(f)).join('')
    expect(wire).not.toContain('top secret')
  })

  it('ignores peers using a different key', async () => {
    const relay = new Relay()
    const errors: unknown[] = []
    const a = await join(relay, await importKey(generateKey()), 'mine')
    const doc = new Y.Doc()
    const b = new RoomClient({
      admissionToken: 'A'.repeat(43),
      url: 'ws://test',
      key: await importKey(generateKey()),
      doc,
      awareness: new Awareness(doc),
      createSocket: relay.create,
      onError: (e) => errors.push(e),
    })
    clients.push(b)
    b.connect()
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
    expect(text(b)).toBe('')
    expect(text(a)).toBe('mine')
  })

  it('delivers attachment messages', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const got: Attachment[] = []
    const a = await join(relay, key)
    const doc = new Y.Doc()
    const b = new RoomClient({
      admissionToken: 'A'.repeat(43),
      url: 'ws://test',
      key,
      doc,
      awareness: new Awareness(doc),
      createSocket: relay.create,
      onAttachment: (at) => got.push(at),
    })
    clients.push(b)
    b.connect()
    await vi.waitFor(() => {
      expect(a.status).toBe('connected')
      expect(b.status).toBe('connected')
    })
    const sent: Attachment = {
      kind: 'announce',
      hash: '0123456789abcdef0123456789abcdef',
      mime: 'image/png',
    }
    a.sendAttachment(sent)
    await vi.waitFor(() => expect(got).toEqual([sent]))
    expect(() => a.sendAttachment({ kind: 'want', hashes: [] })).toThrow()
  })

  it('delivers canvas messages', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const got: CanvasMessage[] = []
    const a = await join(relay, key)
    const doc = new Y.Doc()
    const b = new RoomClient({
      admissionToken: 'A'.repeat(43),
      url: 'ws://test',
      key,
      doc,
      awareness: new Awareness(doc),
      createSocket: relay.create,
      onCanvas: (m) => got.push(m),
    })
    clients.push(b)
    b.connect()
    await vi.waitFor(() => {
      expect(a.status).toBe('connected')
      expect(b.status).toBe('connected')
    })
    const sent: CanvasMessage = { kind: 'edit', id: 'e1', base: '{}', next: '{"nodes":[]}' }
    a.sendCanvas(sent)
    await vi.waitFor(() => expect(got).toEqual([sent]))
    expect(() => a.sendCanvas({ kind: 'applied', id: '' })).toThrow()
  })

  it('skips message types from newer peers', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const errors: unknown[] = []
    const doc = new Y.Doc()
    const b = new RoomClient({
      admissionToken: 'A'.repeat(43),
      url: 'ws://test',
      key,
      doc,
      awareness: new Awareness(doc),
      createSocket: relay.create,
      onError: (e) => errors.push(e),
    })
    clients.push(b)
    b.connect()
    await vi.waitFor(() => expect(b.status).toBe('connected'))
    const newer = relay.create('ws://test')
    await vi.waitFor(() => expect(newer.readyState).toBe(1))
    // A message type, then an attachment kind, that b does not know.
    newer.send(await encrypt(key, new Uint8Array([9, 1, 2, 3])))
    newer.send(await encrypt(key, new Uint8Array([MessageType.Attachment, 9, 1, 2, 3])))
    await join(relay, key, 'after')
    await vi.waitFor(() => expect(text(b)).toBe('after'))
    expect(errors).toEqual([])
    newer.close()
  })

  it('reconnects after the socket drops', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const a = await join(relay, key, 'x')
    await vi.waitFor(() => expect(a.status).toBe('connected'))
    for (const s of relay.sockets) s.close()
    await vi.waitFor(() => expect(a.status).toBe('disconnected'))
    await vi.waitFor(() => expect(a.status).toBe('connected'), { timeout: 3000 })
  })

  it('passes handshake headers to the socket', async () => {
    const relay = new Relay()
    await join(relay, await importKey(generateKey()), '', undefined, { Authorization: 'Bearer t' })
    expect(relay.headers).toEqual([{ Authorization: 'Bearer t' }])
    expect(relay.protocols).toEqual([['pedit-v1', `pedit-admission.${'A'.repeat(43)}`]])
    expect(relay.urls).toEqual(['ws://test'])
  })

  it('stops for good when the host leaves', async () => {
    const relay = new Relay({ hosted: true })
    const key = await importKey(generateKey())
    const host = await join(relay, key, 'x', undefined, { Authorization: 'Bearer t' })
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const guest = await join(relay, key)
    await vi.waitFor(() => expect(text(guest)).toBe('x'))
    await host.destroy()
    await vi.waitFor(() => expect(guest.status).toBe('closed'))
    await new Promise((r) => setTimeout(r, 1500))
    expect(guest.status).toBe('closed')
    expect(relay.urls).toHaveLength(2)
  })

  it('waits out a busy relay longer than a dropped connection, then gets in', async () => {
    const relay = new Relay({ busy: 1 })
    const seen: string[] = []
    const doc = new Y.Doc()
    const client = new RoomClient({
      admissionToken: 'A'.repeat(43),
      url: 'ws://test',
      key: await importKey(generateKey()),
      doc,
      awareness: new Awareness(doc),
      createSocket: relay.create,
      minBackoffMs: 1,
      busyBackoffMs: 200,
      onStatus: (s) => seen.push(s),
    })
    clients.push(client)
    client.connect()
    await vi.waitFor(() => expect(client.status).toBe('busy'))
    // A drop would be retried within a few milliseconds; a busy relay is not.
    await new Promise((r) => setTimeout(r, 50))
    expect(relay.urls).toHaveLength(1)
    await vi.waitFor(() => expect(client.status).toBe('connected'))
    expect(relay.urls).toHaveLength(2)
    expect(seen).toEqual(['connecting', 'busy', 'connecting', 'connected'])
  })

  it('is turned away from a room without a host', async () => {
    const relay = new Relay({ hosted: true })
    const guest = await join(relay, await importKey(generateKey()))
    await vi.waitFor(() => expect(guest.status).toBe('closed'))
  })

  it('stops for good when the room is full', async () => {
    const relay = new Relay({ hosted: true, guests: 1 })
    const key = await importKey(generateKey())
    const host = await join(relay, key, 'x', undefined, { Authorization: 'Bearer t' })
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const first = await join(relay, key)
    await vi.waitFor(() => expect(first.status).toBe('connected'))
    const late = await join(relay, key)
    await vi.waitFor(() => expect(late.status).toBe('full'))
    await new Promise((r) => setTimeout(r, 1500))
    expect(late.status).toBe('full')
    expect(relay.urls).toHaveLength(3)
  })

  it.each([
    [CLIENT_OUTDATED, 'client-outdated'],
    [SERVER_OUTDATED, 'server-outdated'],
    [RELAY_MAINTENANCE, 'maintenance'],
  ] as const)(
    'stops for good when the server turns it away for its version or maintenance (%i)',
    async (code, status) => {
      const relay = new Relay({ refuse: code })
      const client = await join(relay, await importKey(generateKey()))
      await vi.waitFor(() => expect(client.status).toBe(status))
      await new Promise((r) => setTimeout(r, 1500))
      expect(client.status).toBe(status)
      expect(relay.urls).toHaveLength(1)
    },
  )

  it('stops for good when its state does not fit a frame', async () => {
    const relay = new Relay()
    const seen: string[] = []
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'x'.repeat(MAX_FRAME_BYTES))
    const client = new RoomClient({
      admissionToken: 'A'.repeat(43),
      url: 'ws://test',
      key: await importKey(generateKey()),
      doc,
      awareness: new Awareness(doc),
      createSocket: relay.create,
      minBackoffMs: 1,
      onStatus: (s) => seen.push(s),
    })
    clients.push(client)
    client.connect()
    await vi.waitFor(() => expect(client.status).toBe('too-large'))
    await new Promise((r) => setTimeout(r, 100))
    expect(seen).toEqual(['connecting', 'too-large'])
    expect(relay.urls).toHaveLength(1)
    expect(relay.frames).toHaveLength(0)
  })

  it('stops for good when an edit does not fit, after the edit', async () => {
    const relay = new Relay({ hosted: true })
    const key = await importKey(generateKey())
    const host = await join(relay, key, 'x', undefined, { Authorization: 'Bearer t' })
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const guest = await join(relay, key)
    await vi.waitFor(() => expect(text(guest)).toBe('x'))
    guest.doc.transact(() => guest.doc.getText('content').insert(0, 'y'.repeat(MAX_FRAME_BYTES)))
    // Told once the edit is done: the editor is still updating inside it.
    expect(guest.status).toBe('connected')
    await vi.waitFor(() => expect(guest.status).toBe('too-large'))
    await new Promise((r) => setTimeout(r, 100))
    expect(guest.status).toBe('too-large')
    expect(host.status).toBe('connected')
    expect(text(host)).toBe('x')
    expect(relay.frames.every((f) => f.length <= MAX_FRAME_BYTES)).toBe(true)
    expect(relay.urls).toHaveLength(2)
  })

  it('stops for good when the relay says a frame is too big', async () => {
    const relay = new Relay({ maxFrame: 100 })
    const client = await join(relay, await importKey(generateKey()), 'x'.repeat(200))
    await vi.waitFor(() => expect(client.status).toBe('too-large'))
    await new Promise((r) => setTimeout(r, 100))
    expect(client.status).toBe('too-large')
    expect(relay.urls).toHaveLength(1)
  })
})
