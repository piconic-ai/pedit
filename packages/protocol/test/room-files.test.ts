import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  type Attachment,
  type CanvasMessage,
  encodeFileDoc,
  encodeFrame,
  encodeMessage,
  encrypt,
  type FileEntry,
  generateKey,
  importKey,
  MAX_FILE_ID,
  MAX_FRAME_BYTES,
  MessageType,
  Pacer,
  RoomClient,
  type RoomClientOptions,
  SENDER_BYTES,
} from '../src/index.ts'
import { Relay } from '../src/testing.ts'

const clients: RoomClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.destroy()
})

function join(relay: Relay, key: CryptoKey, opts: Partial<RoomClientOptions> = {}) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  // As the editor does: a peer with only the initial state (clock 0) goes unseen.
  awareness.setLocalState({ user: {} })
  const client = new RoomClient({
    admissionToken: 'A'.repeat(43),
    url: 'ws://test',
    key,
    doc,
    awareness,
    createSocket: relay.create,
    minBackoffMs: 1,
    ...opts,
  })
  clients.push(client)
  client.connect()
  return client
}

function file(init = ''): Y.Doc {
  const doc = new Y.Doc()
  if (init) doc.getText('content').insert(0, init)
  return doc
}

const text = (doc: Y.Doc) => doc.getText('content').toString()

const manifest: FileEntry[] = [
  { id: 0, path: 'agenda.md', format: 'text' },
  { id: 1, path: '議事録/notes.md', format: 'text' },
]

describe('RoomClient with several files', () => {
  it('syncs each file in a doc of its own, with file 0 the room doc', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = join(relay, key)
    host.doc.getText('content').insert(0, '# agenda\n')
    const notes = file('# notes\n')
    host.addFile(1, notes)
    host.setManifest(manifest)
    await vi.waitFor(() => expect(host.status).toBe('connected'))

    const heard: FileEntry[][] = []
    const guest = join(relay, key, { onManifest: (files) => heard.push(files) })
    await vi.waitFor(() => expect(heard.at(-1)).toEqual(manifest))
    const gNotes = file()
    guest.addFile(1, gNotes)
    await vi.waitFor(() => {
      expect(text(guest.doc)).toBe('# agenda\n')
      expect(text(gNotes)).toBe('# notes\n')
    })
    gNotes.getText('content').insert(8, '- decided\n')
    host.doc.getText('content').insert(0, '!')
    await vi.waitFor(() => {
      expect(text(notes)).toBe('# notes\n- decided\n')
      expect(text(guest.doc)).toBe('!# agenda\n')
    })
    // A peer that knows nothing of files goes on editing file 0, and only it.
    const older = join(relay, key)
    await vi.waitFor(() => expect(text(older.doc)).toBe('!# agenda\n'))
    older.doc.getText('content').insert(0, '?')
    await vi.waitFor(() => expect(text(host.doc)).toBe('?!# agenda\n'))
    expect(text(notes)).toBe('# notes\n- decided\n')
  })

  it('follows only the files it added, and reports each synced once', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const errors: unknown[] = []
    const synced: number[] = []
    const host = join(relay, key)
    const agenda = file('a')
    const notes = file('n')
    host.addFile(1, agenda)
    host.addFile(2, notes)
    const guest = join(relay, key, {
      onFileSynced: (id) => synced.push(id),
      onError: (e) => errors.push(e),
    })
    const gNotes = file()
    guest.addFile(2, gNotes)
    await vi.waitFor(() => expect(text(gNotes)).toBe('n'))
    agenda.getText('content').insert(1, 'genda')
    notes.getText('content').insert(1, 'otes')
    await vi.waitFor(() => expect(text(gNotes)).toBe('notes'))
    await new Promise((r) => setTimeout(r, 50))
    expect(synced).toEqual([2])
    expect(errors).toEqual([])
  })

  it('syncs a file added while connected', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = join(relay, key)
    const guest = join(relay, key)
    await vi.waitFor(() => {
      expect(host.status).toBe('connected')
      expect(guest.status).toBe('connected')
    })
    const gSpec = file()
    guest.addFile(3, gSpec) // the guest asks first: the host has nothing yet
    host.addFile(3, file('spec'))
    await vi.waitFor(() => expect(text(gSpec)).toBe('spec'))
    expect(() => host.addFile(3, file())).toThrow()
    expect(() => host.addFile(0, file())).toThrow() // the room's own doc
    expect(() => host.addFile(MAX_FILE_ID + 1, file())).toThrow()
    expect(() => host.addFile(1.5, file())).toThrow()
  })

  it('sends the manifest to whoever joins later, and a new one to everyone', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = join(relay, key)
    host.setManifest(manifest)
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const heard: FileEntry[][] = []
    join(relay, key, { onManifest: (files) => heard.push(files) })
    await vi.waitFor(() => expect(heard.at(-1)).toEqual(manifest))
    host.setManifest(manifest.slice(0, 1))
    await vi.waitFor(() => expect(heard.at(-1)).toEqual(manifest.slice(0, 1)))
  })

  it('routes attachment and canvas messages by file', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const got: string[] = []
    const a = join(relay, key)
    const b = join(relay, key, {
      onFileAttachment: (id, at: Attachment) => got.push(`${at.kind}@${id}`),
      onFileCanvas: (id, m: CanvasMessage) => got.push(`${m.id}@${id}`),
      onAttachment: () => got.push('room attachment'),
      onCanvas: () => got.push('room canvas'),
    })
    await vi.waitFor(() => {
      expect(a.status).toBe('connected')
      expect(b.status).toBe('connected')
    })
    a.sendFileAttachment(1, {
      kind: 'announce',
      hash: '0123456789abcdef0123456789abcdef',
      mime: 'image/png',
    })
    a.sendFileCanvas(2, { kind: 'applied', id: 'edit' })
    await vi.waitFor(() => expect(got).toEqual(['announce@1', 'edit@2']))
    expect(() => a.sendFileAttachment(1, { kind: 'want', hashes: [] })).toThrow()
  })

  it('resyncs files after a reconnect', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = join(relay, key)
    const guest = join(relay, key)
    const notes = file('n')
    const gNotes = file()
    host.addFile(1, notes)
    guest.addFile(1, gNotes)
    await vi.waitFor(() => expect(text(gNotes)).toBe('n'))
    relay.closeAll(1006)
    notes.getText('content').insert(1, ' offline') // dropped while disconnected
    await vi.waitFor(() => expect(text(gNotes)).toBe('n offline'))
  })

  it('stops for good when a file does not fit a frame', async () => {
    const relay = new Relay()
    const client = join(relay, await importKey(generateKey()))
    await vi.waitFor(() => expect(client.status).toBe('connected'))
    client.addFile(1, file('x'.repeat(MAX_FRAME_BYTES)))
    await vi.waitFor(() => expect(client.status).toBe('too-large'))
  })

  it('skips files kinds and message types from newer peers', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const errors: unknown[] = []
    const b = join(relay, key, { onError: (e) => errors.push(e) })
    const notes = file()
    b.addFile(1, notes)
    await vi.waitFor(() => expect(b.status).toBe('connected'))
    const newer = relay.create('ws://test')
    await vi.waitFor(() => expect(newer.readyState).toBe(1))
    const sender = new Uint8Array(SENDER_BYTES).fill(1)
    const frames = [
      encodeMessage(MessageType.Files, new Uint8Array([9, 1, 2, 3])),
      encodeMessage(MessageType.Files, new Uint8Array([1, 1, 9, 1, 2, 3])),
    ]
    for (const [i, m] of frames.entries()) {
      newer.send(await encrypt(key, encodeFrame(sender, i + 1, m)))
    }
    const a = join(relay, key)
    a.addFile(1, file('after'))
    await vi.waitFor(() => expect(text(notes)).toBe('after'))
    expect(errors).toEqual([])
    expect(encodeFileDoc(1, MessageType.Sync, new Uint8Array()).length).toBe(3)
    newer.close()
  })
})

describe('pacing', () => {
  // A small allowance, so a few files go over it as forty large ones go over
  // the real relay's.
  const byteRate = { burst: 64 * 1024, perSecond: 256 * 1024 }
  const big = (n: number) => file('x'.repeat(n * 1024))

  it('keeps a room with several large files within the relay allowance', async () => {
    const relay = new Relay({ byteRate })
    const key = await importKey(generateKey())
    const statuses: string[] = []
    const host = join(relay, key, { byteRate, onStatus: (s) => statuses.push(s) })
    for (const id of [1, 2, 3]) host.addFile(id, big(40))
    const guest = join(relay, key, { byteRate })
    const docs = [1, 2, 3].map((id) => {
      const doc = file()
      guest.addFile(id, doc)
      return doc
    })
    await vi.waitFor(() => expect(docs.map((d) => text(d).length)).toEqual([40960, 40960, 40960]), {
      timeout: 5000,
    })
    expect(statuses).not.toContain('disconnected')
    expect(host.status).toBe('connected')
  })

  it('would be closed by the relay without pacing', async () => {
    const relay = new Relay({ byteRate })
    const key = await importKey(generateKey())
    const statuses: string[] = []
    const unpaced = { burst: 1e12, perSecond: 1e12 }
    const host = join(relay, key, { byteRate: unpaced, onStatus: (s) => statuses.push(s) })
    for (const id of [1, 2, 3]) host.addFile(id, big(40))
    await vi.waitFor(() => expect(statuses).toContain('disconnected'))
  })
})

describe('Pacer', () => {
  it('lets a burst through, then waits for the rate, keeping a margin', () => {
    let now = 0
    const pacer = new Pacer(
      { burst: 100, perSecond: 100 },
      { burst: 800, perSecond: 800 },
      () => now,
    )
    // 7/8 of 800 bytes at once.
    expect(pacer.take(700)).toBe(0)
    expect(pacer.take(70)).toBeCloseTo(100) // 70 bytes at 700 a second
    now += 100
    expect(pacer.take(0)).toBe(0)
    // Messages are counted too: 87.5 of them at once, then 87.5 a second.
    const many = new Pacer({ burst: 8, perSecond: 8 }, undefined, () => now)
    for (let i = 0; i < 7; i++) expect(many.take(1)).toBe(0)
    expect(many.take(1)).toBeCloseTo((1 / 7) * 1000)
  })
})
