import { exports } from 'cloudflare:workers'
import {
  admissionProtocols,
  HOST_LEFT,
  READ_ADMISSION_HEADER,
  RoomClient,
  type RoomKeys,
  type RoomStatus,
  type SocketLike,
} from '@pedit/protocol'
import { decodeUint64, encodeCheckpoint, Kind, withKind } from '@pedit/protocol/kinds'
import { Awareness, editKeys, sealBundle, Y } from '@pedit/protocol/testing'
import { describe, expect, it } from 'vitest'

// Browsers as the web page runs them (RoomClient) against the real Room: the
// host is played by hand, with the messages of docs/design/rooms-away.md.

let lastAddress = 0
const nextAddress = () => `10.10.${(lastAddress >> 8) & 255}.${++lastAddress & 255}`

/** A SocketLike over a WebSocket of the Worker, as a browser's is over the network. */
class WorkerSocket implements SocketLike {
  binaryType = 'blob'
  readyState = 0
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  #ws: WebSocket | undefined

  constructor(url: string, protocols: string[]) {
    void this.#start(url, protocols)
  }

  async #start(url: string, protocols: string[]) {
    const res = await exports.default.fetch(url.replace(/^ws/, 'http'), {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': protocols.join(', '),
        'CF-Connecting-IP': nextAddress(),
      },
    })
    const ws = res.webSocket
    if (!ws) {
      this.readyState = 3
      this.onclose?.({ code: 1006 })
      return
    }
    this.#ws = ws
    ws.accept()
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('message', (ev) => this.onmessage?.({ data: ev.data }))
    ws.addEventListener('close', (ev) => {
      this.readyState = 3
      this.onclose?.({ code: ev.code, reason: ev.reason })
    })
    this.readyState = 1
    this.onopen?.({})
  }

  send(data: Uint8Array) {
    this.#ws?.send(data)
  }

  close(code?: number, reason?: string) {
    this.#ws?.close(code, reason)
  }
}

interface Browser {
  client: RoomClient
  doc: Y.Doc
  statuses: RoomStatus[]
  syncs: string[]
  text: () => string
}

function browser(room: { id: string }, keys: RoomKeys, seed?: Uint8Array): Browser {
  const doc = new Y.Doc()
  if (seed) Y.applyUpdate(doc, seed)
  const statuses: RoomStatus[] = []
  const syncs: string[] = []
  const client = new RoomClient({
    url: `ws://pedit.test/api/rooms/${room.id}/ws`,
    keys,
    admissionToken: keys.editAdmission as string,
    doc,
    awareness: new Awareness(doc),
    createSocket: (url, _headers, protocols) => new WorkerSocket(url, protocols ?? []),
    onStatus: (s) => statuses.push(s),
    onKeptSync: (s) => syncs.push(s),
  })
  client.connect()
  return { client, doc, statuses, syncs, text: () => doc.getText('content').toString() }
}

interface Host {
  ws: WebSocket
  binary: Uint8Array[]
  signals: string[]
}

async function host(
  room: { id: string; hostToken: string },
  keys: RoomKeys,
  headers: Record<string, string> = {},
): Promise<Host> {
  const res = await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws`, {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': admissionProtocols(keys.editAdmission as string).join(', '),
      Authorization: `Bearer ${room.hostToken}`,
      [READ_ADMISSION_HEADER]: keys.readAdmission,
      'CF-Connecting-IP': nextAddress(),
      ...headers,
    },
  })
  const ws = res.webSocket as WebSocket
  const h: Host = { ws, binary: [], signals: [] }
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') h.signals.push(ev.data)
    else h.binary.push(new Uint8Array(ev.data as ArrayBuffer))
  })
  ws.binaryType = 'arraybuffer'
  ws.accept()
  return h
}

const until = (check: () => boolean) =>
  expect.poll(check, { interval: 5, timeout: 5000 }).toBe(true)

describe('browsers in a room kept while its host is away', () => {
  it('edit, are replayed to a newcomer, and are live again when the host returns', async () => {
    const created = await exports.default.fetch('https://pedit.test/api/rooms', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': nextAddress() },
    })
    const room = await created.json<{ id: string; hostToken: string }>()
    const keys = await editKeys()

    // The host declares a keep and gives the relay its snapshot, then leaves.
    const hostDoc = new Y.Doc()
    hostDoc.getText('content').insert(0, 'hello')
    const state = Y.encodeStateAsUpdate(hostDoc)
    const snapshot = (update: Uint8Array) =>
      sealBundle(keys, [{ id: 0, path: 'a.md', update }]).then((b) => withKind(Kind.Snapshot, b))
    const first = await host(room, keys, { 'X-Pedit-Keep': '3600' })
    first.ws.send(await snapshot(state))
    const guest = browser(room, keys, state)
    await until(() => guest.client.status === 'connected')
    first.ws.close(HOST_LEFT, 'bye')
    await until(() => guest.client.status === 'kept')
    expect(guest.client.keptUntil).toBeGreaterThan(Date.now())

    // A guest edits; the relay logs it and sends it back.
    guest.doc.getText('content').insert(5, ' world')
    expect(guest.text()).toBe('hello world')
    // Acknowledged: the relay sent it back with an id.
    await until(() => guest.syncs.join() === 'pending,kept')
    // A second guest joins and sees the snapshot and the edit.
    const late = browser(room, keys)
    await until(() => late.text() === 'hello world')
    expect(late.client.status).toBe('kept')
    // It writes too, and the first guest sees it.
    late.doc.getText('content').insert(0, '>> ')
    await until(() => guest.text() === '>> hello world')

    // The host returns with what it holds: it is sent the two entries and the tail.
    const back = await host(room, keys, { 'X-Pedit-Keep': '3600', 'X-Pedit-After': '0' })
    // (Guests that are told the host is back greet it with live frames meanwhile.)
    const replayed = () => back.binary.filter((m) => m[0] !== Kind.Live)
    await until(() => replayed().length === 3)
    expect(replayed().map((m) => m[0])).toEqual([Kind.Logged, Kind.Logged, Kind.LogEnd])
    const tail = decodeUint64(replayed()[2]?.subarray(1) as Uint8Array) as number
    expect(tail).toBe(2)
    // It takes them in and checkpoints.
    const merged = new Y.Doc()
    merged.getText('content').insert(0, '>> hello world')
    back.ws.send(
      encodeCheckpoint(
        tail,
        await sealBundle(keys, [{ id: 0, path: 'a.md', update: Y.encodeStateAsUpdate(merged) }]),
      ),
    )
    await until(() => back.signals.includes('checkpoint 2 2'))

    // Everyone is live again: the guests are told, and send the host their state.
    await until(() => guest.client.status === 'connected' && late.client.status === 'connected')
    const before = back.binary.length
    guest.doc.getText('content').insert(0, '!')
    await until(() => back.binary.length > before)
    expect(replayed()).toHaveLength(3)

    await guest.client.destroy()
    await late.client.destroy()
    back.ws.close()
  }, 20_000)
})
