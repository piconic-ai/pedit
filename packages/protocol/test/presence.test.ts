import * as encoding from 'lib0/encoding'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  encodeMessage,
  MAX_WIRE_CLOCK,
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

function join(
  relay: Relay,
  keys: RoomKeys,
  state: Record<string, unknown> | null = null,
  opts: Partial<RoomClientOptions> = {},
  doc = new Y.Doc(),
) {
  const awareness = new Awareness(doc)
  if (state) awareness.setLocalState(state)
  const client = new RoomClient({
    admissionToken: 'A'.repeat(43),
    url: 'ws://test',
    keys,
    doc,
    awareness,
    createSocket: relay.create,
    ...opts,
  })
  clients.push(client)
  client.connect()
  return client
}

const sender = (n: number) => new Uint8Array(SENDER_BYTES).fill(n)

/** An awareness message with one entry, for an ID and clock of the sender's choosing. */
function stateFor(id: number, clock: number, state: unknown): Uint8Array {
  const update = encoding.createEncoder()
  encoding.writeVarUint(update, 1)
  encoding.writeVarUint(update, id)
  encoding.writeVarUint(update, clock)
  encoding.writeVarString(update, JSON.stringify(state))
  const message = encoding.createEncoder()
  encoding.writeVarUint8Array(message, encoding.toUint8Array(update))
  return encodeMessage(MessageType.Awareness, encoding.toUint8Array(message))
}

describe('presence', () => {
  it('lists everyone with the access of the link they joined with', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const host = join(relay, keys, { name: 'host' })
    const commenter = join(relay, await lowerKeys(keys, 'comment'), { name: 'c' })
    const reader = join(relay, await lowerKeys(keys, 'read'), { name: 'r' })
    const all = [host, commenter, reader]
    await vi.waitFor(() => {
      for (const c of all) expect(c.awareness.getStates().size).toBe(3)
    })
    for (const c of all) {
      expect(c.accessOf(host.doc.clientID)).toBe('edit')
      expect(c.accessOf(commenter.doc.clientID)).toBe('comment')
      expect(c.accessOf(reader.doc.clientID)).toBe('read')
    }
  })

  it('keeps an editor in place against states claimed first from below', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const errors: unknown[] = []
    const newcomer = join(relay, keys, null, { onError: (e) => errors.push(e) })
    await vi.waitFor(() => expect(newcomer.status).toBe('connected'))
    const peer = relay.create('ws://test')
    await vi.waitFor(() => expect(peer.readyState).toBe(1))
    // The host's client ID, known before it joins, as it is to anyone who
    // was in the room before.
    const hostDoc = new Y.Doc()
    const hostId = hostDoc.clientID
    const read = await lowerKeys(keys, 'read')
    const comment = await lowerKeys(keys, 'comment')
    peer.send(
      await sealFrame(read, sender(1), 1, stateFor(hostId, MAX_WIRE_CLOCK, { file: 'evil.md' })),
    )
    peer.send(await sealFrame(read, sender(1), 2, stateFor(hostId + 1, MAX_WIRE_CLOCK + 1, {})))
    await vi.waitFor(() => expect(newcomer.awareness.getStates().get(hostId)).toBeDefined())

    join(relay, keys, { role: 'host', file: 'notes.md' }, {}, hostDoc)
    const file = () => newcomer.awareness.getStates().get(hostId)?.file
    await vi.waitFor(() => expect(file()).toBe('notes.md'))

    peer.send(await sealFrame(read, sender(1), 3, stateFor(hostId, MAX_WIRE_CLOCK, null)))
    peer.send(await sealFrame(comment, sender(2), 1, stateFor(hostId, 9, { file: 'evil.md' })))
    await vi.waitFor(() =>
      expect(errors.filter((e) => e instanceof NotAllowedError)).toHaveLength(3),
    )
    expect(file()).toBe('notes.md')
    expect(newcomer.accessOf(hostId)).toBe('edit')
    peer.close()
  })

  it('takes one state a frame, and none for its own ID', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const errors: unknown[] = []
    const me = join(relay, keys, { name: 'me' }, { onError: (e) => errors.push(e) })
    await vi.waitFor(() => expect(me.status).toBe('connected'))
    const peer = relay.create('ws://test')
    await vi.waitFor(() => expect(peer.readyState).toBe(1))
    const update = encoding.createEncoder()
    encoding.writeVarUint(update, 2)
    for (const id of [7, 8]) {
      encoding.writeVarUint(update, id)
      encoding.writeVarUint(update, 1)
      encoding.writeVarString(update, '{}')
    }
    const several = encoding.createEncoder()
    encoding.writeVarUint8Array(several, encoding.toUint8Array(update))
    peer.send(
      await sealFrame(
        keys,
        sender(1),
        1,
        encodeMessage(MessageType.Awareness, encoding.toUint8Array(several)),
      ),
    )
    peer.send(await sealFrame(keys, sender(1), 2, stateFor(me.doc.clientID, 99, null)))
    await vi.waitFor(() => expect(errors).toHaveLength(2))
    expect(me.awareness.getLocalState()).toEqual({ name: 'me' })
    expect(me.awareness.getStates().size).toBe(1)
    peer.close()
  })
})
