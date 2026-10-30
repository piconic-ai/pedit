import { afterEach, describe, expect, it } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  decodeFrame,
  decodeMessage,
  decrypt,
  HEADER_BYTES,
  HOST_AWAY,
  HOST_BACK,
  type KeptSync,
  MessageType,
  openMessage,
  RoomClient,
  type RoomKeys,
  type RoomStatus,
} from '../src/index.ts'
import { sealKeptUpdate } from '../src/kept-text.ts'
import { decodeUint64, encodeLogEnd, encodeLogged, Kind, withKind } from '../src/kinds.ts'
import { editKeys, type FakeSocket, lowerKeys, Relay, sealBundle } from '../src/testing.ts'

const clients: RoomClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.destroy()
})

const settle = () => new Promise((r) => setTimeout(r, 20))
const textUpdate = (apply: (text: Y.Text) => void, from?: Y.Doc) => {
  const doc = new Y.Doc()
  if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from))
  let update: Uint8Array = new Uint8Array()
  doc.on('update', (u: Uint8Array) => {
    update = u
  })
  apply(doc.getText('content'))
  return { doc, update }
}

interface Member {
  client: RoomClient
  doc: Y.Doc
  relay: Relay
  statuses: RoomStatus[]
  syncs: KeptSync[]
  skipped: number[]
  manifests: { id: number; path: string; format: string }[][]
  socket: () => FakeSocket
  say: (data: string | Uint8Array) => Promise<void>
}

async function member(keys: RoomKeys, relay = new Relay()): Promise<Member> {
  const doc = new Y.Doc()
  const m = { statuses: [], syncs: [], skipped: [], manifests: [] } as unknown as Member
  const client = new RoomClient({
    admissionToken: 'A'.repeat(43),
    url: 'ws://test/room',
    keys,
    doc,
    awareness: new Awareness(doc),
    createSocket: relay.create,
    minBackoffMs: 1,
    maxBackoffMs: 1,
    onStatus: (s) => m.statuses.push(s),
    onKeptSync: (s) => m.syncs.push(s),
    onKeptSkipped: (n) => m.skipped.push(n),
    onManifest: (files) => m.manifests.push(files),
  })
  clients.push(client)
  client.connect()
  await settle()
  Object.assign(m, {
    client,
    doc,
    relay,
    socket: () => [...relay.sockets].at(-1) as FakeSocket,
    say: async (data: string | Uint8Array) => {
      m.socket().onmessage?.({ data: typeof data === 'string' ? data : data.slice().buffer })
      await settle()
    },
  })
  return m
}

/** What a client sent as entries, in order. */
const entries = (relay: Relay) =>
  relay.frames.filter((f) => f[0] === Kind.Entry).map((f) => f.subarray(1))

/** The types of the live messages a client sent from `from` on. */
async function live(keys: RoomKeys, relay: Relay, from = 0) {
  const types: MessageType[] = []
  for (const frame of relay.frames.slice(from)) {
    if (frame[0] !== Kind.Live) continue
    const plain = await decrypt(keys.frameKey, frame.subarray(1))
    const opened = await openMessage(
      keys,
      plain.subarray(0, HEADER_BYTES),
      decodeFrame(plain).message,
    )
    types.push(decodeMessage(opened.message).type)
  }
  return types
}

const UNTIL = 1_900_000_000_000

describe('a room kept while its host is away', () => {
  it('enters the kept status and says until when; the words of a version 5 relay still wait', async () => {
    const keys = await editKeys()
    const m = await member(keys)
    await m.say(`kept ${UNTIL}`)
    expect(m.client.status).toBe('kept')
    expect(m.client.keptUntil).toBe(UNTIL)
    await m.say(HOST_BACK)
    expect(m.client.status).toBe('connected')
    const old = await member(keys)
    await old.say(HOST_AWAY)
    expect(old.client.status).toBe('waiting')
    await old.say(HOST_BACK)
    expect(old.client.status).toBe('connected')
  })

  it('sends an edit as an entry, pending until the relay logs it, and not as a live update', async () => {
    const keys = await editKeys()
    const m = await member(keys)
    await m.say(`kept ${UNTIL}`)
    const before = m.relay.frames.length
    m.doc.getText('content').insert(0, 'hello')
    await settle()
    expect(m.syncs).toEqual(['pending'])
    const sent = entries(m.relay)
    expect(sent).toHaveLength(1)
    expect(await live(keys, m.relay, before)).toEqual([])
    // The relay sends it back with an id: acknowledged, and not applied twice.
    await m.say(encodeLogged(1, sent[0]!))
    expect(m.syncs).toEqual(['pending', 'kept'])
    expect(m.doc.getText('content').toString()).toBe('hello')
  })

  it('applies entries others wrote, and skips and counts those that do not hold', async () => {
    const keys = await editKeys()
    const m = await member(keys)
    await m.say(`kept ${UNTIL}`)
    const first = textUpdate((t) => t.insert(0, 'abc'))
    await m.say(encodeLogged(1, await sealKeptUpdate(keys, 0, first.update)))
    expect(m.doc.getText('content').toString()).toBe('abc')
    // Another room's key, a file nobody listed, and noise.
    const other = await editKeys()
    await m.say(encodeLogged(2, await sealKeptUpdate(other, 0, first.update)))
    await m.say(encodeLogged(3, new Uint8Array([1, 2, 3])))
    // An update that puts a second root type in the doc.
    const stray = new Y.Doc()
    let bad: Uint8Array = new Uint8Array()
    stray.on('update', (u: Uint8Array) => {
      bad = u
    })
    stray.getMap('other').set('a', 1)
    await m.say(encodeLogged(4, await sealKeptUpdate(keys, 0, bad)))
    expect(m.skipped.at(-1)).toBe(3)
    expect(m.doc.getText('content').toString()).toBe('abc')
  })

  it('builds the docs from the snapshot and the log, and asks for the rest on a reconnect', async () => {
    const keys = await editKeys()
    const m = await member(keys)
    const notes = textUpdate((t) => t.insert(0, 'notes'))
    const comments = new Y.Doc()
    let meta: Uint8Array = new Uint8Array()
    comments.on('update', (u: Uint8Array) => {
      meta = u
    })
    comments.getMap('comments').set('t1', 'a thread')
    await m.say(`kept ${UNTIL}`)
    await m.say(
      withKind(
        Kind.Replay,
        await sealBundle(keys, [
          { id: 0, path: 'a.md', update: textUpdate((t) => t.insert(0, 'first')).update },
          { id: 1, path: 'b.md', update: notes.update },
          { id: 2, path: '.pedit/meta/b.md.json', update: meta },
        ]),
      ),
    )
    expect(m.doc.getText('content').toString()).toBe('first')
    expect(m.manifests).toEqual([
      [
        { id: 0, path: 'a.md', format: 'text' },
        { id: 1, path: 'b.md', format: 'text' },
        { id: 2, path: '.pedit/meta/b.md.json', format: 'meta' },
      ],
    ])
    // A file opened after the replay gets its content, and then the log's entries.
    const second = new Y.Doc()
    m.client.addFile(1, second)
    expect(second.getText('content').toString()).toBe('notes')
    const more = textUpdate((t) => t.insert(5, ' and more'), notes.doc)
    await m.say(encodeLogged(7, await sealKeptUpdate(keys, 1, more.update)))
    await m.say(encodeLogEnd(7))
    expect(second.getText('content').toString()).toBe('notes and more')
    // The comments of a file are checked as in a live room.
    const metaDoc = new Y.Doc()
    m.client.addFile(2, metaDoc, undefined, { comments: true })
    expect(metaDoc.getMap('comments').get('t1')).toBe('a thread')
    // The connection drops: the next one says what is held.
    m.socket().close(1006)
    await new Promise((r) => setTimeout(r, 30))
    expect(m.relay.urls[0]).toBe('ws://test/room')
    expect(m.relay.urls.at(-1)).toBe('ws://test/room?after=7')
  })

  it('sends what the relay lacks once it has replayed, such as edits made while disconnected', async () => {
    const keys = await editKeys()
    const m = await member(keys)
    const base = textUpdate((t) => t.insert(0, 'abc')).update
    const replay = async () => {
      await m.say(`kept ${UNTIL}`)
      await m.say(
        withKind(Kind.Replay, await sealBundle(keys, [{ id: 0, path: 'a.md', update: base }])),
      )
      await m.say(encodeLogEnd(0))
    }
    // The connection drops, and an edit is made before it is back.
    m.socket().close(1006)
    m.doc.getText('content').insert(0, 'Y')
    await new Promise((r) => setTimeout(r, 30))
    // An edit that could not go out is not pending: the replay finds it missing.
    expect(m.syncs).toEqual([])
    await replay()
    // Nothing was sent before the replay: the relay's copy comes first.
    expect(m.doc.getText('content').toString()).toContain('abc')
    expect(entries(m.relay)).toHaveLength(1)
    const sent = entries(m.relay)[0]!
    await m.say(encodeLogged(1, sent))
    expect(m.syncs).toEqual(['pending', 'kept'])
    // Another drop with an edit pending: the next replay has the log without it.
    m.doc.getText('content').insert(0, 'X')
    await settle()
    m.socket().close(1006)
    await new Promise((r) => setTimeout(r, 30))
    expect(m.relay.urls.at(-1)).toBe('ws://test/room?after=1')
    await m.say(`kept ${UNTIL}`)
    await m.say(encodeLogEnd(1))
    expect(entries(m.relay)).toHaveLength(3)
    // The relay had it all: nothing is sent again.
    await m.say(encodeLogged(2, entries(m.relay)[2]!))
    m.socket().close(1006)
    await new Promise((r) => setTimeout(r, 30))
    await m.say(`kept ${UNTIL}`)
    await m.say(encodeLogEnd(2))
    expect(entries(m.relay)).toHaveLength(3)
  })

  it('joins again when it was live as the room becomes kept, to be sent the snapshot and the log', async () => {
    const m = await member(await editKeys())
    await m.say(HOST_AWAY)
    expect(m.relay.urls).toHaveLength(1)
    await m.say(`kept ${UNTIL}`)
    await new Promise((r) => setTimeout(r, 30))
    expect(m.relay.urls).toEqual(['ws://test/room', 'ws://test/room'])
    expect(m.client.status).toBe('connected')
  })

  it('goes live again on host back: every doc is synced for the host', async () => {
    const keys = await editKeys()
    const m = await member(keys)
    m.client.addFile(1, new Y.Doc())
    await m.say(`kept ${UNTIL}`)
    m.doc.getText('content').insert(0, 'edited away')
    await settle()
    const from = m.relay.frames.length
    await m.say(HOST_BACK)
    expect(m.client.status).toBe('connected')
    // What is held goes: the host takes the state by sync.
    expect(m.syncs.at(-1)).toBe('kept')
    const types = await live(keys, m.relay, from)
    expect(types.filter((t) => t === MessageType.Fresh)).toHaveLength(1)
    expect(types.filter((t) => t === MessageType.Sync)).toHaveLength(2)
    expect(types.filter((t) => t === MessageType.Files).length).toBeGreaterThanOrEqual(2)
    // Edits are live updates again.
    const sent = entries(m.relay).length
    m.doc.getText('content').insert(0, '!')
    await settle()
    expect(entries(m.relay)).toHaveLength(sent)
  })

  it('never sends an entry from a read link, but follows the log', async () => {
    const writer = await editKeys()
    const keys = await lowerKeys(writer, 'read')
    const m = await member(keys)
    await m.say(`kept ${UNTIL}`)
    m.doc.getText('content').insert(0, 'local')
    await settle()
    expect(entries(m.relay)).toHaveLength(0)
    expect(m.syncs).toEqual([])
    const update = textUpdate((t) => t.insert(0, 'from an editor'))
    await m.say(encodeLogged(1, await sealKeptUpdate(writer, 0, update.update)))
    expect(m.doc.getText('content').toString()).toContain('from an editor')
  })

  it('surfaces a full log as a status', async () => {
    const m = await member(await editKeys())
    await m.say(`kept ${UNTIL}`)
    await m.say('log full')
    expect(m.client.status).toBe('log-full')
    await m.say(HOST_BACK)
    expect(m.client.status).toBe('connected')
  })

  it('reads the tail as the last entry held', async () => {
    const m = await member(await editKeys())
    await m.say(`kept ${UNTIL}`)
    await m.say(encodeLogEnd(12))
    m.socket().close(1006)
    await new Promise((r) => setTimeout(r, 30))
    expect(new URL(m.relay.urls.at(-1)!).searchParams.get('after')).toBe('12')
    expect(decodeUint64(encodeLogEnd(12).subarray(1))).toBe(12)
  })
})
