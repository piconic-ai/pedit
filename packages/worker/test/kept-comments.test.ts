import { runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import {
  ADMISSION_PROTOCOL_PREFIX,
  COMMENT_ADMISSION_HEADER,
  COMMENT_ADMISSION_PROTOCOL_PREFIX,
  READ_ADMISSION_HEADER,
} from '@pedit/protocol/admission'
import { HOST_LEFT, KEPT_COMMENTS, ROOM_FULL } from '@pedit/protocol/close'
import { decodeLogged, Kind, withKind } from '@pedit/protocol/kinds'
import { describe, expect, it } from 'vitest'
import { checkpoint, KEPT_LOG_BYTES, KEPT_LOG_ENTRIES } from '../src/kept-away.ts'
import { limits, type Room as RoomObject } from '../src/room.ts'

const POLICY = 1008
const CLIENT_OUTDATED = 4002

interface Room {
  id: string
  hostToken: string
  admission: string
  read: string
  comment: string
}

interface Peer {
  ws: WebSocket
  binary: Uint8Array[]
  signals: string[]
  closed: Promise<CloseEvent>
}

let lastAddress = 0
const nextAddress = () => {
  lastAddress++
  return `10.8.${(lastAddress >> 8) & 255}.${lastAddress & 255}`
}

const token = (letter: string) => crypto.randomUUID().replaceAll('-', '') + letter.repeat(11)

async function createRoom(): Promise<Room> {
  const res = await exports.default.fetch('https://pedit.test/api/rooms', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': nextAddress() },
  })
  expect(res.status).toBe(201)
  const room = await res.json<Room>()
  room.admission = token('A')
  room.read = token('R')
  room.comment = token('C')
  return room
}

interface Options {
  host?: boolean
  /** Join with the reader token. */
  reader?: boolean
  /** The comment token to offer beside the reader token. */
  comment?: string
  /** Offered versions; default v7 only, as clients do today. */
  versions?: number[]
  /** The comment header the host sends. */
  hostComment?: string | null
  keep?: string
}

async function connect(room: Room, o: Options = {}): Promise<Peer> {
  const versions = o.versions ?? [7]
  const protocols = [
    ...versions.map((v) => `pedit-v${v}`),
    `${ADMISSION_PROTOCOL_PREFIX}${o.reader || o.comment ? room.read : room.admission}`,
  ]
  if (o.comment) protocols.push(`${COMMENT_ADMISSION_PROTOCOL_PREFIX}${o.comment}`)
  const headers: Record<string, string> = {
    Upgrade: 'websocket',
    'Sec-WebSocket-Protocol': protocols.join(', '),
    'CF-Connecting-IP': nextAddress(),
  }
  if (o.host) {
    headers.Authorization = `Bearer ${room.hostToken}`
    headers[READ_ADMISSION_HEADER] = room.read
    const comment = o.hostComment === undefined ? room.comment : o.hostComment
    if (comment !== null) headers[COMMENT_ADMISSION_HEADER] = comment
    headers['X-Pedit-Keep'] = o.keep ?? '3600'
  }
  const res = await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws`, { headers })
  expect(res.status).toBe(101)
  expect(res.headers.get('Sec-WebSocket-Protocol')).toBe(`pedit-v${Math.max(...versions)}`)
  const ws = res.webSocket as WebSocket
  const binary: Uint8Array[] = []
  const signals: string[] = []
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') signals.push(ev.data)
    else binary.push(new Uint8Array(ev.data as ArrayBuffer))
  })
  ws.binaryType = 'arraybuffer'
  ws.accept()
  return { ws, binary, signals, closed }
}

const stubOf = (room: Room) => env.ROOM.get(env.ROOM.idFromName(room.id))
const inRoom = <T>(room: Room, fn: (r: RoomObject, st: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(stubOf(room), fn)
const until = (check: () => boolean) =>
  expect.poll(check, { interval: 5, timeout: 3000 }).toBe(true)
const bytes = (...n: number[]) => new Uint8Array(n)
const quiet = () => new Promise((r) => setTimeout(r, 40))
const closedWithin = (p: Peer) =>
  Promise.race([p.closed.then((e) => e.code), quiet().then(() => undefined)])

/** The host takes a snapshot and leaves on purpose; the room is kept. */
async function keepRoom(room: Room, o: Options = {}) {
  const host = await connect(room, { host: true, ...o })
  host.ws.send(withKind(Kind.Snapshot, bytes(9, 9)))
  host.ws.close(HOST_LEFT, 'bye')
  await host.closed
}

const v8 = { versions: [7, 8] }
const commenterOf = (room: Room, o: Options = {}) =>
  connect(room, { ...v8, comment: room.comment, ...o })
const readerOf = (room: Room, o: Options = {}) => connect(room, { reader: true, ...v8, ...o })

describe('version negotiation', () => {
  it('accepts pedit-v8 and still pedit-v7, answering the negotiated one', async () => {
    const room = await createRoom()
    // connect() checks the answered subprotocol is the newest offered.
    await connect(room, { host: true, versions: [7] })
    await connect(room, { versions: [7, 8] })
    await connect(room, { versions: [8] })
  })

  it('does not close a version 7 socket as outdated when a version 8 one joins', async () => {
    const room = await createRoom()
    const host = await connect(room, { host: true })
    const old = await connect(room, { versions: [7] })
    await commenterOf(room)
    await readerOf(room)
    expect(await closedWithin(old)).toBeUndefined()
    expect(await closedWithin(host)).toBeUndefined()
    // And it can still write.
    old.ws.send(withKind(Kind.Live, bytes(1)))
    await quiet()
  })

  it('still turns away versions below the minimum', async () => {
    const room = await createRoom()
    const old = await connect(room, { host: true, versions: [7] })
    old.ws.close(1000, 'x')
    const res = await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws`, {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `pedit-v6, ${ADMISSION_PROTOCOL_PREFIX}${room.admission}`,
        'CF-Connecting-IP': nextAddress(),
      },
    })
    const ws = res.webSocket as WebSocket
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
    ws.accept()
    expect((await closed).code).toBe(CLIENT_OUTDATED)
  })
})

describe('commenter role', () => {
  const kept = async (o: Options = {}) => {
    const room = await createRoom()
    await connect(room, { host: true, ...o }).then(async (h) => {
      h.ws.send(withKind(Kind.Snapshot, bytes(9, 9)))
      h.ws.close(HOST_LEFT, 'bye')
      await h.closed
    })
    return room
  }

  it('admits a guest with both tokens as a commenter, who may write entries', async () => {
    const room = await kept()
    const commenter = await commenterOf(room)
    const editor = await connect(room, { versions: [7] })
    commenter.ws.send(withKind(Kind.Entry, bytes(5, 6)))
    await until(() => editor.binary.some((m) => m[0] === Kind.Logged))
    const logged = editor.binary.find((m) => m[0] === Kind.Logged)
    expect(decodeLogged(logged!.subarray(1))?.id).toBe(1)
    // The writer gets its acknowledgement too.
    await until(() => commenter.binary.some((m) => m[0] === Kind.Logged))
  })

  it('makes a reader of a guest with a wrong comment token or none registered', async () => {
    const room = await kept()
    const wrong = await commenterOf(room, { comment: token('W') })
    wrong.ws.send(withKind(Kind.Entry, bytes(1)))
    expect((await wrong.closed).code).toBe(POLICY)

    const bare = await kept({ hostComment: null })
    const unregistered = await commenterOf(bare)
    unregistered.ws.send(withKind(Kind.Entry, bytes(1)))
    expect((await unregistered.closed).code).toBe(POLICY)

    const plain = await readerOf(room)
    plain.ws.send(withKind(Kind.Entry, bytes(1)))
    expect((await plain.closed).code).toBe(POLICY)
  })

  it('makes a reader of a version 7 socket even with the comment token', async () => {
    const room = await kept()
    const old = await commenterOf(room, { versions: [7] })
    old.ws.send(withKind(Kind.Entry, bytes(1)))
    expect((await old.closed).code).toBe(POLICY)
  })

  it('honours the comment header from the host only', async () => {
    const room = await createRoom()
    // A guest cannot register one, not even before the host comes.
    const res = await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws`, {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `pedit-v8, ${ADMISSION_PROTOCOL_PREFIX}${room.admission}`,
        [COMMENT_ADMISSION_HEADER]: room.comment,
        'CF-Connecting-IP': nextAddress(),
      },
    })
    expect(res.status === 101 ? res.webSocket : null).not.toBeNull()
    const stored = await inRoom(room, (_, st) => st.storage.kv.get('commentAdmissionHash'))
    expect(stored).toBeUndefined()
  })

  it('refuses a malformed comment header', async () => {
    const room = await createRoom()
    const res = await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${room.hostToken}`,
        'Sec-WebSocket-Protocol': `pedit-v7, ${ADMISSION_PROTOCOL_PREFIX}${room.admission}`,
        [COMMENT_ADMISSION_HEADER]: 'short',
        'CF-Connecting-IP': nextAddress(),
      },
    })
    expect(res.status).toBe(403)
  })

  it('may not send kinds 2 and 3', async () => {
    const room = await kept()
    for (const kind of [Kind.Snapshot, Kind.Checkpoint]) {
      const commenter = await commenterOf(room)
      commenter.ws.send(withKind(kind, bytes(1, 2, 3)))
      expect((await commenter.closed).code).toBe(POLICY)
    }
  })

  it('relays live frames like a reader', async () => {
    const room = await createRoom()
    const host = await connect(room, { host: true })
    const commenter = await commenterOf(room)
    commenter.ws.send(withKind(Kind.Live, bytes(4)))
    await until(() => host.binary.length === 1)
  })

  it('counts toward the readers cap and not the editors', async () => {
    const room = await createRoom()
    await connect(room, { host: true })
    const { readers } = limits(env)
    for (let i = 0; i < readers - 1; i++) await readerOf(room)
    await commenterOf(room)
    const full = await commenterOf(room)
    expect((await full.closed).code).toBe(ROOM_FULL)
    // An editor still gets in.
    await connect(room, { versions: [7] })
  })

  it('may fill a quarter of the log, and editors keep theirs', async () => {
    const room = await kept()
    const commenter = await commenterOf(room)
    const editor = await connect(room, { versions: [7] })
    const quarter = KEPT_LOG_ENTRIES / 4
    await inRoom(room, (_, st) => {
      for (let id = 1; id < quarter; id++)
        st.storage.sql.exec(
          "INSERT INTO kept_text_log (id, body, sender) VALUES (?, x'00', 'c')",
          id,
        )
      st.storage.kv.put('awayLog', { tail: quarter - 1, cutoff: 0 })
    })
    commenter.ws.send(withKind(Kind.Entry, bytes(1)))
    await until(() => commenter.binary.some((m) => decodeLogged(m.subarray(1))?.id === quarter))
    commenter.ws.send(withKind(Kind.Entry, bytes(2)))
    await until(() => commenter.signals.includes('log full'))
    editor.ws.send(withKind(Kind.Entry, bytes(3)))
    await until(() => editor.binary.some((m) => decodeLogged(m.subarray(1))?.id === quarter + 1))
  })

  it('may fill a quarter of the log bytes', async () => {
    const room = await kept()
    const commenter = await commenterOf(room)
    await inRoom(room, (_, st) => {
      st.storage.sql.exec(
        "INSERT INTO kept_text_log (id, body, sender) VALUES (1, zeroblob(?), 'c')",
        KEPT_LOG_BYTES / 4 - 1,
      )
      st.storage.kv.put('awayLog', { tail: 1, cutoff: 0 })
    })
    commenter.ws.send(withKind(Kind.Entry, bytes(1)))
    await until(() => commenter.binary.some((m) => decodeLogged(m.subarray(1))?.id === 2))
    commenter.ws.send(withKind(Kind.Entry, bytes(2)))
    await until(() => commenter.signals.includes('log full'))
  })

  it('frees the commenters share when a checkpoint drops their entries', async () => {
    const room = await kept()
    const commenter = await commenterOf(room)
    const quarter = KEPT_LOG_ENTRIES / 4
    await inRoom(room, (_, st) => {
      for (let id = 1; id <= quarter; id++)
        st.storage.sql.exec(
          "INSERT INTO kept_text_log (id, body, sender) VALUES (?, x'00', 'c')",
          id,
        )
      st.storage.kv.put('awayLog', { tail: quarter, cutoff: 0 })
    })
    commenter.ws.send(withKind(Kind.Entry, bytes(1)))
    await until(() => commenter.signals.includes('log full'))
    await inRoom(room, (_, st) => checkpoint(st.storage, quarter, bytes(7)))
    commenter.ws.send(withKind(Kind.Entry, bytes(2)))
    await until(() => commenter.binary.some((m) => decodeLogged(m.subarray(1))?.id === quarter + 1))
  })
})

describe('announcing comments', () => {
  it('sends kept comments after kept to version 8 sockets only, when a hash exists', async () => {
    const room = await createRoom()
    const host = await connect(room, { host: true })
    const old = await connect(room, { versions: [7] })
    const modern = await connect(room, { versions: [7, 8] })
    const commenter = await commenterOf(room)
    host.ws.send(withKind(Kind.Snapshot, bytes(9, 9)))
    host.ws.close(HOST_LEFT, 'bye')
    await host.closed
    await until(() => commenter.signals.length === 2)
    for (const p of [modern, commenter]) {
      expect(p.signals[0]).toMatch(/^kept \d+$/)
      expect(p.signals[1]).toBe(KEPT_COMMENTS)
    }
    expect(old.signals).toHaveLength(1)
    expect(old.signals[0]).toMatch(/^kept \d+$/)

    // A peer that joins the kept room is told the same.
    const late = await connect(room, { versions: [7, 8] })
    // A reader, as the room's three editor places are taken.
    const lateOld = await connect(room, { reader: true, versions: [7] })
    await until(() => late.signals.length === 2 && lateOld.signals.length === 1)
    expect(late.signals[1]).toBe(KEPT_COMMENTS)
  })

  it('sends no kept comments when the host registered no comment token', async () => {
    const room = await createRoom()
    const host = await connect(room, { host: true, hostComment: null })
    const modern = await connect(room, { versions: [7, 8] })
    host.ws.send(withKind(Kind.Snapshot, bytes(9, 9)))
    host.ws.close(HOST_LEFT, 'bye')
    await host.closed
    await until(() => modern.signals.length === 1)
    await quiet()
    expect(modern.signals).toHaveLength(1)
    const late = await connect(room, { versions: [7, 8] })
    await until(() => late.signals.length === 1)
    await quiet()
    expect(late.signals).toHaveLength(1)
  })

  it('clears the comment hash when the session ends', async () => {
    const room = await createRoom()
    const host = await connect(room, { host: true, keep: '0' })
    expect(await inRoom(room, (_, st) => st.storage.kv.get('commentAdmissionHash'))).toBeDefined()
    host.ws.close(HOST_LEFT, 'bye')
    await host.closed
    await until(() => true)
    await expect
      .poll(() => inRoom(room, (_, st) => st.storage.kv.get('commentAdmissionHash')), {
        interval: 10,
        timeout: 3000,
      })
      .toBeUndefined()
  })
})
