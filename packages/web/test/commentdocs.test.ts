import {
  type FileEntry,
  generateKey,
  importKey,
  MAX_FILES,
  metaFiles,
  RoomClient,
} from '@pedit/protocol'
import { Relay } from '@pedit/protocol/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { CommentDocs } from '../src/commentdocs.ts'

const clients: RoomClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.destroy()
})

function join(relay: Relay, key: CryptoKey) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalState({ user: {} })
  const client = new RoomClient({
    admissionToken: 'A'.repeat(43),
    url: 'ws://test',
    key,
    doc,
    awareness,
    createSocket: relay.create,
    minBackoffMs: 1,
  })
  clients.push(client)
  client.connect()
  return client
}

const text = (doc: Y.Doc) => doc.getText('content').toString()

describe('CommentDocs', () => {
  it('lets go of a comments doc a forged list put under a file id, so the file opens', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const host = join(relay, key)
    const notes = new Y.Doc()
    notes.getText('content').insert(0, 'the real file 1')
    host.addFile(1, notes)
    const guest = join(relay, key)
    const docs = new CommentDocs(guest)
    // A forged list: file 1 is file 0's comments.
    const forged: FileEntry[] = [
      { id: 0, path: 'notes.md', format: 'text' },
      { id: 1, path: '.pedit/meta/notes.md.json', format: 'meta' },
    ]
    expect([...metaFiles(forged)]).toEqual([[0, 1]])
    expect(docs.docFor(1)).not.toBeNull()
    // The host's own list has file 1 as a file: opening it works.
    expect(docs.takeForFile(1)).toBe(true)
    const opened = new Y.Doc()
    expect(() => guest.addFile(1, opened)).not.toThrow()
    await vi.waitFor(() => expect(text(opened)).toBe('the real file 1'))
    // And no list puts comments under it again.
    expect(docs.docFor(1)).toBeNull()
    expect(docs.takeForFile(1)).toBe(false)
  })

  it('joins no comments doc under the room doc, nor more than a room has files', async () => {
    const relay = new Relay()
    const key = await importKey(generateKey())
    const docs = new CommentDocs(join(relay, key))
    expect(docs.docFor(0)).toBeNull()
    const first = docs.docFor(1)
    expect(docs.docFor(1)).toBe(first)
    for (let id = 2; id <= MAX_FILES; id++) expect(docs.docFor(id)).not.toBeNull()
    expect(docs.docFor(MAX_FILES + 1)).toBeNull()
  })
})
