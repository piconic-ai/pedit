import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  decodeFresh,
  encodeCanvas,
  encodeFresh,
  encodeMessage,
  MessageType,
  NONCE_BYTES,
  RoomClient,
  type RoomClientOptions,
  type RoomKeys,
  SENDER_BYTES,
  SETTLE_AFTER_MS,
} from '../src/index.ts'
import { answer, editKeys, lowerKeys, Relay, sealFrame } from '../src/testing.ts'

const clients: RoomClient[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.destroy()
})

function join(relay: Relay, keys: RoomKeys, opts: Partial<RoomClientOptions> = {}) {
  const doc = new Y.Doc()
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

const edit = (id: string) =>
  encodeMessage(MessageType.Canvas, encodeCanvas({ kind: 'edit', id, base: '{}', next: '{}' }))

describe('fresh messages', () => {
  it('round-trip, with an answer or without', () => {
    const nonce = new Uint8Array(NONCE_BYTES).fill(1)
    const other = new Uint8Array(NONCE_BYTES).fill(9)
    expect(decodeFresh(encodeFresh({ nonce }))).toEqual({ nonce })
    expect(decodeFresh(encodeFresh({ nonce, answer: other }))).toEqual({ nonce, answer: other })
    for (const n of [0, 15, 17, 31, 33]) {
      expect(() => decodeFresh(new Uint8Array(n))).toThrow()
    }
  })

  // From the security review of #122: someone with a read link keeps an
  // editor's frame and has it sent again to a peer that has just joined,
  // which has no counter from that editor yet. The newcomer takes the
  // editor's frames only from its answer to the newcomer's nonce on.
  it('keep a newcomer from taking frames kept from before', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const host = join(relay, keys)
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    const before = relay.frames.length
    host.sendCanvas({ kind: 'edit', id: 'old', base: '{}', next: '{}' })
    // Alone in the room, the host holds it until it settles (fresh.ts).
    await vi.waitFor(() => expect(relay.frames.length).toBe(before + 1), {
      timeout: SETTLE_AFTER_MS + 2000,
    })
    const kept = relay.frames[before] as Uint8Array

    const peer = relay.create('ws://test')
    await vi.waitFor(() => expect(peer.readyState).toBe(1))
    const edits: string[] = []
    const newcomer = join(relay, await lowerKeys(keys, 'read'), {
      onCanvas: (m) => edits.push(m.id),
    })
    // Sent again before and after the newcomer heard from the host.
    const replay = setInterval(() => peer.send(kept), 1)
    try {
      await vi.waitFor(() => expect(newcomer.status).toBe('connected'))
      await vi.waitFor(() => expect(relay.frames.length).toBeGreaterThan(before + 20))
      host.sendCanvas({ kind: 'edit', id: 'new', base: '{}', next: '{}' })
      await vi.waitFor(() => expect(edits).toContain('new'))
    } finally {
      clearInterval(replay)
    }
    expect(edits).toEqual(['new'])
    peer.close()
  })

  it('take a signer as live only from an answer to the nonce of this connection', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const edits: string[] = []
    const me = join(relay, keys, { onCanvas: (m) => edits.push(m.id) })
    await vi.waitFor(() => expect(me.status).toBe('connected'))
    const peer = relay.create('ws://test')
    await vi.waitFor(() => expect(peer.readyState).toBe(1))
    const sender = new Uint8Array(SENDER_BYTES).fill(1)
    const wrong = encodeMessage(
      MessageType.Fresh,
      encodeFresh({
        nonce: new Uint8Array(NONCE_BYTES),
        answer: new Uint8Array(NONCE_BYTES).fill(1),
      }),
    )
    for (const [counter, message] of [
      edit('before any answer'),
      wrong,
      edit("after another nonce's"),
      answer(me),
      edit('after the answer'),
    ].entries()) {
      peer.send(await sealFrame(keys, sender, counter + 1, message))
    }
    await vi.waitFor(() => expect(edits.length).toBeGreaterThan(0))
    expect(edits).toEqual(['after the answer'])
    peer.close()
  })
})

describe('what is sent once', () => {
  // What a newcomer sends once right after connecting, before peers know it
  // is live, still reaches them: the newcomer holds it until it settles.
  it('reaches peers when sent right after connecting', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const edits: string[] = []
    const host = join(relay, keys, { onCanvas: (m) => edits.push(m.id) })
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    // As soon as it is connected, before it heard from anyone.
    const newcomer: RoomClient = join(relay, keys, {
      onStatus: (status) => {
        if (status !== 'connected') return
        for (const id of ['first', 'second']) {
          newcomer.sendCanvas({ kind: 'edit', id, base: '{}', next: '{}' })
        }
      },
    })
    await vi.waitFor(() => expect(edits).toEqual(['first', 'second']))
  })
})

describe('a reconnection', () => {
  // From review: a signer answers the nonce of every connection, a
  // reconnection too, or frames it sent while the peer was away could be
  // sent again to it.
  it('needs signers to show again that they are live', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const edits: string[] = []
    const me = join(relay, keys, { onCanvas: (m) => edits.push(m.id) })
    await vi.waitFor(() => expect(me.status).toBe('connected'))
    const sender = new Uint8Array(SENDER_BYTES).fill(1)
    const write = async (...frames: [number, Uint8Array][]) => {
      const peer = relay.create('ws://test')
      await vi.waitFor(() => expect(peer.readyState).toBe(1))
      for (const [counter, message] of frames) {
        peer.send(await sealFrame(keys, sender, counter, message))
      }
    }
    await write([1, answer(me)], [2, edit('before')])
    await vi.waitFor(() => expect(edits).toEqual(['before']))

    // The signer goes on while `me` is away; someone keeps its frame.
    const kept = edit('while away')
    const nonce = me.nonce
    for (const s of relay.sockets) s.close()
    await vi.waitFor(() => expect(me.status).toBe('disconnected'))
    await vi.waitFor(() => expect(me.status).toBe('connected'), { timeout: 3000 })
    expect(me.nonce).not.toEqual(nonce)
    await write([3, kept], [4, answer(me)], [5, edit('after')])
    await vi.waitFor(() => expect(edits).toContain('after'))
    expect(edits).toEqual(['before', 'after'])
  })
})
