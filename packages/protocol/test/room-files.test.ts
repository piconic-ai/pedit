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
  { id: 1, path: 'agenda.md', format: 'text' },
  { id: 2, path: '議事録/board.canvas', format: 'canvas' },
]

describe('RoomClient with several files', () => {
  it('syncs each file in a doc of its own', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = join(relay, key)
    const agenda = file('# agenda\n')
    const notes = file('# notes\n')
    host.addFile(1, agenda)
    host.addFile(2, notes)
    host.setManifest(manifest)
    await vi.waitFor(() => expect(host.status).toBe('connected'))

    const heard: FileEntry[][] = []
    const guest = join(relay, key, { onManifest: (files) => heard.push(files) })
    await vi.waitFor(() => expect(heard.at(-1)).toEqual(manifest))
    const gAgenda = file()
    const gNotes = file()
    guest.addFile(1, gAgenda)
    guest.addFile(2, gNotes)
    await vi.waitFor(() => {
      expect(text(gAgenda)).toBe('# agenda\n')
      expect(text(gNotes)).toBe('# notes\n')
    })
    gNotes.getText('content').insert(8, '- decided\n')
    agenda.getText('content').insert(0, '!')
    await vi.waitFor(() => {
      expect(text(notes)).toBe('# notes\n- decided\n')
      expect(text(gAgenda)).toBe('!# agenda\n')
    })
    // The room's own doc stays empty: a peer that knows nothing of files has
    // nothing to save.
    expect(text(host.doc)).toBe('')
    expect(text(guest.doc)).toBe('')
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
