import * as encoding from 'lib0/encoding'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import {
  type Access,
  BadSignatureError,
  decrypt,
  encodeAttachment,
  encodeCanvas,
  encodeFileDoc,
  encodeManifest,
  encodeMessage,
  encrypt,
  MessageType,
  NotAllowedError,
  RoomClient,
  type RoomClientOptions,
  type RoomKeys,
  SENDER_BYTES,
} from '../src/index.ts'
import { editKeys, lowerKeys, Relay, sealFrame } from '../src/testing.ts'

const clients: RoomClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.destroy()
})

function join(relay: Relay, keys: RoomKeys, init = '', opts: Partial<RoomClientOptions> = {}) {
  const doc = new Y.Doc()
  if (init) doc.getText('content').insert(0, init)
  const client = new RoomClient({
    admissionToken: 'A'.repeat(43),
    url: 'ws://test',
    keys,
    doc,
    awareness: new Awareness(doc),
    createSocket: relay.create,
    ...opts,
  })
  clients.push(client)
  client.connect()
  return client
}

const text = (doc: Y.Doc) => doc.getText('content').toString()
const sender = (n: number) => new Uint8Array(SENDER_BYTES).fill(n)

function encodeSync(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder()
  write(encoder)
  return encoding.toUint8Array(encoder)
}

/** An update that inserts `s` into a doc's content, from a client of its own. */
function insertUpdate(s: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, s)
  return Y.encodeStateAsUpdate(doc)
}

function awarenessMessage(state: Record<string, unknown>): Uint8Array {
  const awareness = new Awareness(new Y.Doc())
  awareness.setLocalState(state)
  return encodeSync((e) =>
    encoding.writeVarUint8Array(e, encodeAwarenessUpdate(awareness, [awareness.clientID])),
  )
}

describe('room links below edit', () => {
  it('read the file and write nothing to it', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const host = join(relay, keys, 'hello')
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const commenter = join(relay, await lowerKeys(keys, 'comment'))
    const reader = join(relay, await lowerKeys(keys, 'read'))
    await vi.waitFor(() => {
      expect(text(commenter.doc)).toBe('hello')
      expect(text(reader.doc)).toBe('hello')
    })
    commenter.doc.getText('content').insert(0, 'C')
    reader.doc.getText('content').insert(0, 'R')
    const editor = join(relay, keys)
    await vi.waitFor(() => expect(text(editor.doc)).toBe('hello'))
    editor.doc.getText('content').insert(5, '!')
    await vi.waitFor(() => {
      expect(text(host.doc)).toBe('hello!')
      expect(text(commenter.doc)).toBe('Chello!')
      expect(text(reader.doc)).toBe('Rhello!')
    })
  })

  it('change nothing with frames their access does not allow, signed or not', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const errors: unknown[] = []
    const heard: string[] = []
    const host = join(relay, keys, 'hello', {
      onError: (e) => errors.push(e),
      onCanvas: () => heard.push('canvas'),
      onManifest: () => heard.push('manifest'),
      onAttachment: (a) => heard.push(a.kind),
    })
    host.awareness.setLocalState({ role: 'host', file: 'notes.md' })
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const peer = relay.create('ws://test')
    await vi.waitFor(() => expect(peer.readyState).toBe(1))
    const update = insertUpdate('FORGED ')
    const hash = '0'.repeat(32)
    const forbidden = [
      encodeMessage(
        MessageType.Sync,
        encodeSync((e) => syncProtocol.writeUpdate(e, update)),
      ),
      encodeMessage(
        MessageType.Sync,
        encodeSync((e) => {
          encoding.writeVarUint(e, syncProtocol.messageYjsSyncStep2)
          encoding.writeVarUint8Array(e, update)
        }),
      ),
      encodeMessage(
        MessageType.Canvas,
        encodeCanvas({ kind: 'edit', id: 'e1', base: '{}', next: '{}' }),
      ),
      encodeMessage(
        MessageType.Attachment,
        encodeAttachment({ kind: 'announce', hash, mime: 'image/png' }),
      ),
      encodeMessage(
        MessageType.Attachment,
        encodeAttachment({ kind: 'stored', hash, path: 'assets/x.png' }),
      ),
      encodeMessage(
        MessageType.Files,
        encodeManifest([{ id: 1, path: 'evil.md', format: 'text' }]),
      ),
      encodeMessage(MessageType.Awareness, awarenessMessage({ role: 'host', file: 'evil.md' })),
    ]
    const want = encodeMessage(
      MessageType.Attachment,
      encodeAttachment({ kind: 'want', hashes: [hash] }),
    )
    let counter = 0
    for (const access of ['comment', 'read'] as Access[]) {
      const lower = await lowerKeys(keys, access)
      for (const m of [...forbidden, want]) {
        peer.send(await sealFrame(lower, sender(access === 'comment' ? 1 : 2), ++counter, m))
      }
    }
    // A commenter's signature that claims to be an editor's.
    const comment = await lowerKeys(keys, 'comment')
    const frame = await sealFrame(comment, sender(5), 1, forbidden[2] as Uint8Array)
    const plain = await decrypt(keys.frameKey, frame)
    plain[SENDER_BYTES + 8 + 1] = 0
    peer.send(await encrypt(keys.frameKey, plain))

    await vi.waitFor(() => {
      expect(errors.filter((e) => e instanceof NotAllowedError)).toHaveLength(2 * forbidden.length)
      expect(errors.filter((e) => e instanceof BadSignatureError)).toHaveLength(1)
    })
    expect(text(host.doc)).toBe('hello')
    expect(heard).toEqual(['want', 'want'])
    expect([...host.awareness.getStates().keys()]).toEqual([host.doc.clientID])
    peer.close()
  })

  it('cannot have an editor dropped by naming its sender', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const heard: string[] = []
    const host = join(relay, keys, '', { onCanvas: (m) => heard.push(m.id) })
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const peer = relay.create('ws://test')
    await vi.waitFor(() => expect(peer.readyState).toBe(1))
    const edit = (id: string) =>
      encodeMessage(MessageType.Canvas, encodeCanvas({ kind: 'edit', id, base: '{}', next: '{}' }))
    const far = 2 ** 52
    peer.send(await sealFrame(await lowerKeys(keys, 'comment'), sender(7), far, edit('commenter')))
    peer.send(await sealFrame(await lowerKeys(keys, 'read'), sender(7), far, edit('reader')))
    peer.send(await sealFrame(keys, sender(7), 1, edit('editor')))
    await vi.waitFor(() => expect(heard).toEqual(['editor']))
    peer.close()
  })

  it('let commenters write comments, and nobody below an editor the file', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const errors: unknown[] = []
    const host = join(relay, keys, '', { onError: (e) => errors.push(e) })
    const hostNotes = new Y.Doc()
    const hostComments = new Y.Doc()
    host.addFile(1, hostNotes)
    host.addFile(2, hostComments, undefined, { comments: true })
    const docs = async (access: Access) => {
      const client = join(relay, await lowerKeys(keys, access))
      const notes = new Y.Doc()
      const comments = new Y.Doc()
      client.addFile(1, notes)
      client.addFile(2, comments, undefined, { comments: true })
      return { notes, comments }
    }
    const commenter = await docs('comment')
    const reader = await docs('read')
    commenter.notes.getText('content').insert(0, 'c')
    reader.notes.getText('content').insert(0, 'r')
    reader.comments.getText('content').insert(0, 'from the reader')
    commenter.comments.getText('content').insert(0, 'from the commenter')
    await vi.waitFor(() => {
      expect(text(hostComments)).toBe('from the commenter')
      expect(text(reader.comments)).toContain('from the commenter')
    })
    // A hostile reader's client sends its comment anyway, and a hostile
    // commenter's its edit of the file.
    const peer = relay.create('ws://test')
    await vi.waitFor(() => expect(peer.readyState).toBe(1))
    const update = (file: number) =>
      encodeMessage(
        MessageType.Files,
        encodeFileDoc(
          file,
          MessageType.Sync,
          encodeSync((e) => syncProtocol.writeUpdate(e, insertUpdate('FORGED'))),
        ),
      )
    peer.send(await sealFrame(await lowerKeys(keys, 'read'), sender(1), 1, update(2)))
    peer.send(await sealFrame(await lowerKeys(keys, 'comment'), sender(2), 1, update(1)))
    await vi.waitFor(() =>
      expect(errors.filter((e) => e instanceof NotAllowedError)).toHaveLength(2),
    )
    expect(text(hostNotes)).toBe('')
    expect(text(hostComments)).toBe('from the commenter')
    peer.close()
  })
})
