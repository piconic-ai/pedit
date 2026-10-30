import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import {
  ADMISSION_HEADER,
  admissionProtocols,
  READ_ADMISSION_HEADER,
} from '@pedit/protocol/admission'
import { HOST_LEFT } from '@pedit/protocol/close'
import { decodeLogged, decodeUint64, encodeCheckpoint, Kind, withKind } from '@pedit/protocol/kinds'
import { describe, expect, it } from 'vitest'
import { awayLog, hasSnapshot } from '../src/kept-away.ts'
import type { Room as RoomObject } from '../src/room.ts'

const ROOM_CLOSED = 4001
const ROOM_EXPIRED = 4007
const CLIENT_OUTDATED = 4002
const POLICY = 1008
const DAY = 86400
// The tests run with ROOM_MAX_SECONDS 7200 and KEEP_MAX_SECONDS 604800.
const ROOM_SECONDS = 7200
const KEEP_MAX = 604800

interface Room {
  id: string
  hostToken: string
  admission: string
  read: string
}

interface Peer {
  ws: WebSocket
  /** Binary messages, as arrays. */
  binary: Uint8Array[]
  /** The relay's texts. */
  signals: string[]
  closed: Promise<CloseEvent>
}

let lastAddress = 0
const nextAddress = () => {
  lastAddress++
  return `10.9.${(lastAddress >> 8) & 255}.${lastAddress & 255}`
}

async function createRoom(): Promise<Room> {
  const res = await exports.default.fetch('https://pedit.test/api/rooms', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': nextAddress() },
  })
  expect(res.status).toBe(201)
  const room = await res.json<Room>()
  room.admission = crypto.randomUUID().replaceAll('-', '') + 'A'.repeat(11)
  room.read = crypto.randomUUID().replaceAll('-', '') + 'R'.repeat(11)
  return room
}

interface Options {
  host?: boolean
  reader?: boolean
  version?: 5 | 6
  keep?: string
  after?: number
  /** Send the cursor as `?after=` on the URL, as a browser must. */
  query?: boolean
}

async function join(room: Room, o: Options = {}): Promise<Peer> {
  const headers: Record<string, string> = {
    Upgrade: 'websocket',
    'Sec-WebSocket-Protocol': admissionProtocols(
      o.reader ? room.read : room.admission,
      o.version ?? 6,
    ).join(', '),
    'CF-Connecting-IP': nextAddress(),
  }
  if (o.host) {
    headers.Authorization = `Bearer ${room.hostToken}`
    headers[READ_ADMISSION_HEADER] = room.read
  }
  if (o.keep !== undefined) headers['X-Pedit-Keep'] = o.keep
  if (o.after !== undefined && !o.query) headers['X-Pedit-After'] = String(o.after)
  const query = o.query && o.after !== undefined ? `?after=${o.after}` : ''
  const res = await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws${query}`, {
    headers,
  })
  expect(res.status).toBe(101)
  expect(res.headers.get('Sec-WebSocket-Protocol')).toBe(`pedit-v${o.version ?? 6}`)
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

const hostOf = (room: Room, keep: string | undefined = '3600', o: Options = {}) =>
  join(room, { host: true, keep, ...o })

const stubOf = (room: Room) => env.ROOM.get(env.ROOM.idFromName(room.id))
const inRoom = <T>(room: Room, fn: (r: RoomObject, st: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(stubOf(room), fn)

const until = (check: () => boolean) =>
  expect.poll(check, { interval: 5, timeout: 3000 }).toBe(true)
const bytes = (...n: number[]) => new Uint8Array(n)
const kinds = (p: Peer) => p.binary.map((m) => m[0])
const quiet = () => new Promise((r) => setTimeout(r, 40))
const closedWithin = (p: Peer) =>
  Promise.race([p.closed.then((e) => e.code), quiet().then(() => undefined)])

/** The host sends a snapshot and leaves on purpose; peers are told the room is kept. */
async function leave(room: Room, h: Peer, snapshot = bytes(9, 9)) {
  h.ws.send(withKind(Kind.Snapshot, snapshot))
  h.ws.close(HOST_LEFT, 'bye')
  await h.closed
}

const state = (room: Room) =>
  inRoom(room, async (_, st) => ({
    until: st.storage.kv.get<number>('keptAwayUntil'),
    keep: st.storage.kv.get<number>('keepSeconds'),
    opened: st.storage.kv.get<number>('openedAt'),
    snapshot: hasSnapshot(st.storage),
    log: awayLog(st.storage),
    alarm: await st.storage.getAlarm(),
    rows: st.storage.kv.get('awayData') === undefined ? 0 : 1,
  }))

describe('framing of protocol version 6', () => {
  it('adds and strips the kind byte for a version 5 peer, and sends it no other kind', async () => {
    const room = await createRoom()
    const h = await join(room, { host: true })
    const old = await join(room, { version: 5 })
    const fresh = await join(room)
    // v6 to v5 and v6: the byte is stripped for the v5 peer only.
    h.ws.send(withKind(Kind.Live, bytes(7, 8)))
    await until(() => old.binary.length === 1 && fresh.binary.length === 1)
    expect([...old.binary[0]!]).toEqual([7, 8])
    expect([...fresh.binary[0]!]).toEqual([0, 7, 8])
    // v5 to v6: the kind is put before.
    old.ws.send(bytes(5, 5, 5))
    await until(() => h.binary.length === 1 && fresh.binary.length === 2)
    expect([...h.binary[0]!]).toEqual([0, 5, 5, 5])
    expect([...fresh.binary[1]!]).toEqual([0, 5, 5, 5])
    // An entry while the host is here goes to the host and the other v6 peers only.
    fresh.ws.send(withKind(Kind.Entry, bytes(1, 2, 3)))
    await until(() => h.binary.length === 2)
    expect([...h.binary[1]!]).toEqual([1, 1, 2, 3])
    h.ws.send(withKind(Kind.Live, bytes(4)))
    await until(() => old.binary.length === 2)
    expect([...old.binary[1]!]).toEqual([4])
    expect(old.binary).toHaveLength(2)
  })

  it('accepts the newest version a client offers', async () => {
    const room = await createRoom()
    await join(room, { host: true })
    const both = await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws`, {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `pedit-v5, pedit-v6, pedit-admission.${room.admission}`,
        'CF-Connecting-IP': nextAddress(),
      },
    })
    expect(both.headers.get('Sec-WebSocket-Protocol')).toBe('pedit-v6')
    both.webSocket?.accept()
    both.webSocket?.close()
  })

  it('closes a peer whose version 6 message has no kind, or a kind only the relay sends', async () => {
    const room = await createRoom()
    await join(room, { host: true })
    const empty = await join(room)
    empty.ws.send(new Uint8Array())
    expect((await empty.closed).code).toBe(1003)
    for (const kind of [Kind.Logged, Kind.Replay, Kind.LogEnd]) {
      const peer = await join(room)
      peer.ws.send(withKind(kind, bytes(0, 0, 0, 0, 0, 0, 0, 1)))
      expect((await peer.closed).code).toBe(1003)
    }
    // A kind of a later version is ignored.
    const peer = await join(room)
    peer.ws.send(withKind(42, bytes(1)))
    expect(await closedWithin(peer)).toBeUndefined()
  })
})

describe('the host declares a keep', () => {
  it('is answered with the keep after the relay clamps it', async () => {
    const room = await createRoom()
    const h = await hostOf(room, '3600')
    await until(() => h.signals.length === 1)
    expect(h.signals).toEqual(['keep 3600 0'])
    const other = await createRoom()
    const big = await hostOf(other, String(KEEP_MAX * 10))
    await until(() => big.signals.length === 1)
    expect(big.signals).toEqual([`keep ${KEEP_MAX} 0`])
    expect((await state(other)).keep).toBe(KEEP_MAX)
  })

  it('takes a header that is not a whole number as no keep', async () => {
    for (const keep of ['-5', '1.5', 'x', '']) {
      const room = await createRoom()
      const h = await hostOf(room, keep)
      await until(() => h.signals.length === 1)
      expect(h.signals).toEqual(['keep 0 0'])
      expect((await state(room)).keep).toBe(0)
    }
  })

  it('says nothing and keeps nothing without the header', async () => {
    const room = await createRoom()
    const h = await join(room, { host: true })
    const guest = await join(room)
    await quiet()
    expect(h.signals).toEqual([])
    expect(guest.signals).toEqual([])
    expect((await state(room)).keep).toBe(0)
    h.ws.send(withKind(Kind.Snapshot, bytes(1)))
    await quiet()
    expect((await state(room)).snapshot).toBe(false)
    h.ws.close(HOST_LEFT, 'bye')
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
  })

  it('is the host`s to declare, with a host token that checked out', async () => {
    const room = await createRoom()
    await join(room, { host: true })
    const guest = await join(room, { keep: '3600' })
    await quiet()
    expect(guest.signals).toEqual([])
    expect((await state(room)).keep).toBe(0)
    // A bad host token is refused before the header matters.
    const res = await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws`, {
      headers: {
        Upgrade: 'websocket',
        Authorization: `Bearer ${'x'.repeat(43)}`,
        'X-Pedit-Keep': '3600',
        'Sec-WebSocket-Protocol': admissionProtocols(room.admission).join(', '),
        'CF-Connecting-IP': nextAddress(),
      },
    })
    expect(res.status).toBe(403)
  })

  it('is not kept for a version 5 host', async () => {
    const room = await createRoom()
    const h = await join(room, { host: true, keep: '3600', version: 5 })
    await quiet()
    expect(h.signals).toEqual([])
    expect((await state(room)).keep).toBe(0)
  })

  it('lets the room last as long as the keep, or the relay`s limit if that is longer', async () => {
    const lasts = async (keep: string) => {
      const room = await createRoom()
      await hostOf(room, keep)
      const { opened } = await state(room)
      return inRoom(room, (r) => (r['deadline']() - (opened as number)) / 1000)
    }
    expect(await lasts('60')).toBe(ROOM_SECONDS)
    expect(await lasts(String(DAY))).toBe(DAY)
  })
})

describe('the snapshot and the checkpoint', () => {
  it('are taken from the host, and no one else', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    const guest = await join(room)
    h.ws.send(withKind(Kind.Snapshot, bytes(1, 2, 3)))
    await expect.poll(async () => (await state(room)).snapshot).toBe(true)
    // Nothing is relayed.
    await quiet()
    expect(guest.binary).toHaveLength(0)
    guest.ws.send(withKind(Kind.Snapshot, bytes(6)))
    expect((await guest.closed).code).toBe(POLICY)
    const other = await join(room, { reader: true })
    other.ws.send(encodeCheckpoint(0, bytes(6)))
    expect((await other.closed).code).toBe(POLICY)
  })

  it('replace the last snapshot', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    h.ws.send(withKind(Kind.Snapshot, bytes(1)))
    h.ws.send(withKind(Kind.Snapshot, bytes(2, 2)))
    h.ws.close(HOST_LEFT, 'bye')
    await h.closed
    const guest = await join(room)
    await until(() => guest.binary.length === 2)
    expect([...guest.binary[0]!]).toEqual([Kind.Replay, 2, 2])
  })

  it('refuse a cutoff beyond the tail, and set the cutoff otherwise', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    h.ws.send(encodeCheckpoint(1, bytes(4)))
    await until(() => h.signals.includes('checkpoint refused'))
    expect((await state(room)).snapshot).toBe(false)
    h.ws.send(encodeCheckpoint(0, bytes(4)))
    await until(() => h.signals.includes('checkpoint 0 0'))
    expect((await state(room)).snapshot).toBe(true)
    // Not a checkpoint at all.
    h.ws.send(withKind(Kind.Checkpoint, bytes(1, 2)))
    expect((await h.closed).code).toBe(1003)
  })
})

describe('a room kept while its host is away', () => {
  /** A room with a host that left, a writer and a reader in it. */
  async function away() {
    const room = await createRoom()
    const h = await hostOf(room, '3600')
    const writer = await join(room)
    const other = await join(room)
    const reader = await join(room, { reader: true })
    await leave(room, h)
    await until(() =>
      [writer, other, reader].every((p) => p.signals.some((s) => /^kept \d+$/.test(s))),
    )
    return { room, writer, other, reader }
  }

  it('tells every peer until when, and closes nobody', async () => {
    const before = Date.now()
    const { room, writer, other, reader } = await away()
    const until_ = (await state(room)).until as number
    expect(until_).toBeGreaterThanOrEqual(before + 3600 * 1000)
    expect(until_).toBeLessThanOrEqual(Date.now() + 3600 * 1000)
    for (const p of [writer, other, reader]) {
      expect(p.signals).toEqual([`kept ${until_}`])
      expect(await closedWithin(p)).toBeUndefined()
    }
    expect((await state(room)).alarm).toBe(until_)
  })

  it('logs an editor`s entries and relays them as kind 4 with increasing ids', async () => {
    const { writer, other, reader } = await away()
    writer.ws.send(withKind(Kind.Entry, bytes(10, 11)))
    other.ws.send(withKind(Kind.Entry, bytes(12)))
    await until(() => [writer, other, reader].every((p) => p.binary.length === 2))
    for (const p of [writer, other, reader]) {
      expect(kinds(p)).toEqual([Kind.Logged, Kind.Logged])
      const first = decodeLogged(p.binary[0]!.subarray(1))
      const second = decodeLogged(p.binary[1]!.subarray(1))
      expect([first?.id, [...(first?.entry ?? [])]]).toEqual([1, [10, 11]])
      expect([second?.id, [...(second?.entry ?? [])]]).toEqual([2, [12]])
    }
  })

  it('still relays live frames, and closes a reader that writes an entry', async () => {
    const { writer, other, reader } = await away()
    writer.ws.send(withKind(Kind.Live, bytes(3, 3)))
    await until(() => other.binary.length === 1 && reader.binary.length === 1)
    expect([...other.binary[0]!]).toEqual([0, 3, 3])
    reader.ws.send(withKind(Kind.Entry, bytes(1)))
    expect((await reader.closed).code).toBe(POLICY)
    expect(writer.binary).toHaveLength(0)
  })

  it('refuses an entry when the log is full, and relays nothing', async () => {
    const { room, writer, other } = await away()
    // The log holds 10,000 entries: all but one are there.
    await inRoom(room, (_, st) => {
      for (let id = 1; id < 10000; id++)
        st.storage.sql.exec(
          "INSERT INTO kept_text_log (id, body, sender) VALUES (?, x'00', '')",
          id,
        )
      st.storage.kv.put('awayLog', { tail: 9999, cutoff: 0 })
    })
    writer.ws.send(withKind(Kind.Entry, bytes(1)))
    await until(() => other.binary.length === 1)
    expect(decodeLogged(other.binary[0]!.subarray(1))?.id).toBe(10000)
    writer.ws.send(withKind(Kind.Entry, bytes(2)))
    await until(() => writer.signals.includes('log full'))
    await quiet()
    expect(other.binary).toHaveLength(1)
    expect((await state(room)).log.tail).toBe(10000)
  })

  it('sends a peer that joins the snapshot, the entries after its cutoff, and the tail', async () => {
    const { room, writer } = await away()
    writer.ws.send(withKind(Kind.Entry, bytes(10)))
    writer.ws.send(withKind(Kind.Entry, bytes(11)))
    await until(() => writer.binary.length === 2)
    const joiner = await join(room)
    await until(() => joiner.binary.length === 4)
    expect(joiner.signals).toEqual([`kept ${(await state(room)).until}`])
    expect(kinds(joiner)).toEqual([Kind.Replay, Kind.Logged, Kind.Logged, Kind.LogEnd])
    expect([...joiner.binary[0]!.subarray(1)]).toEqual([9, 9])
    expect(decodeUint64(joiner.binary[3]!.subarray(1))).toBe(2)
  })

  it('sends the entries after X-Pedit-After, and the tail alone to a peer that has them all', async () => {
    const { room, writer, other } = await away()
    for (const n of [10, 11, 12]) writer.ws.send(withKind(Kind.Entry, bytes(n)))
    await until(() => writer.binary.length === 3)
    other.ws.close()
    const partial = await join(room, { after: 2 })
    await until(() => partial.binary.length === 2)
    expect(kinds(partial)).toEqual([Kind.Logged, Kind.LogEnd])
    expect(decodeLogged(partial.binary[0]!.subarray(1))?.id).toBe(3)
    partial.ws.close()
    const current = await join(room, { after: 3 })
    await until(() => current.binary.length === 1)
    expect(kinds(current)).toEqual([Kind.LogEnd])
    expect(decodeUint64(current.binary[0]!.subarray(1))).toBe(3)
    current.ws.close()
    // A cursor beyond the tail is not one the relay gave: the whole log.
    const lost = await join(room, { after: 99 })
    await until(() => lost.binary.length === 5)
    expect(kinds(lost)).toEqual([Kind.Replay, 4, 4, 4, Kind.LogEnd])
  })

  it('reads the cursor from ?after= too, which a browser can send', async () => {
    const { room, writer } = await away()
    for (const n of [10, 11, 12]) writer.ws.send(withKind(Kind.Entry, bytes(n)))
    await until(() => writer.binary.length === 3)
    const partial = await join(room, { after: 2, query: true })
    await until(() => partial.binary.length === 2)
    expect(kinds(partial)).toEqual([Kind.Logged, Kind.LogEnd])
    expect(decodeLogged(partial.binary[0]!.subarray(1))?.id).toBe(3)
  })

  it('tells a version 5 peer that the host is away, as for a host that dropped', async () => {
    const { room, writer } = await away()
    writer.ws.send(withKind(Kind.Entry, bytes(10)))
    await until(() => writer.binary.length === 1)
    const old = await join(room, { version: 5 })
    await until(() => old.signals.length === 1)
    expect(old.signals).toEqual(['host away'])
    await quiet()
    expect(old.binary).toHaveLength(0)
    writer.ws.send(withKind(Kind.Entry, bytes(11)))
    writer.ws.send(withKind(Kind.Live, bytes(1)))
    await until(() => old.binary.length === 1)
    // Only the live frame, without its kind.
    expect([...old.binary[0]!]).toEqual([1])
  })

  it('takes images from editors and shows them to readers', async () => {
    const { room } = await away()
    const url = `https://pedit.test/api/rooms/${room.id}/blobs/${'B'.repeat(22)}`
    const put = (token: string) =>
      exports.default.fetch(url, {
        method: 'PUT',
        body: bytes(1, 2, 3),
        headers: { [ADMISSION_HEADER]: token },
      })
    expect((await put(room.admission)).status).toBe(201)
    expect((await put(room.read)).status).toBe(403)
    expect((await put('Z'.repeat(43))).status).toBe(403)
    for (const token of [room.admission, room.read]) {
      const res = await exports.default.fetch(url, { headers: { [ADMISSION_HEADER]: token } })
      expect([res.status, [...new Uint8Array(await res.arrayBuffer())]]).toEqual([200, [1, 2, 3]])
    }
  })
})

describe('a host that returns to a kept room', () => {
  it('is sent the entries after what it holds, then the tail, and the room is its own again', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    const guest = await join(room)
    await leave(room, h)
    for (const n of [10, 11, 12]) guest.ws.send(withKind(Kind.Entry, bytes(n)))
    await until(() => guest.binary.length === 3)

    const back = await hostOf(room, '3600', { after: 1 })
    await until(() => back.binary.length === 3)
    // The cutoff is 0: it holds the snapshot already.
    expect(kinds(back)).toEqual([Kind.Logged, Kind.Logged, Kind.LogEnd])
    expect(decodeLogged(back.binary[0]!.subarray(1))?.id).toBe(2)
    expect(back.signals).toEqual(['keep 3600 0'])
    await until(() => guest.signals.includes('host back'))
    expect((await state(room)).until).toBeUndefined()

    // Entries now go to the host as kind 1, and are not logged.
    guest.ws.send(withKind(Kind.Entry, bytes(13)))
    await until(() => back.binary.length === 4)
    expect([...back.binary[3]!]).toEqual([Kind.Entry, 13])
    expect((await state(room)).log.tail).toBe(3)

    // A checkpoint cuts the log.
    back.ws.send(encodeCheckpoint(3, bytes(7, 7)))
    await until(() => back.signals.includes('checkpoint 3 3'))
    expect((await state(room)).log).toEqual({ tail: 3, cutoff: 3 })
  })

  it('is sent the snapshot too when the log was cut after what it holds', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    const guest = await join(room)
    await leave(room, h)
    guest.ws.send(withKind(Kind.Entry, bytes(10)))
    await until(() => guest.binary.length === 1)
    const back = await hostOf(room, '3600', { after: 0 })
    await until(() => back.binary.length === 2)
    back.ws.send(encodeCheckpoint(1, bytes(8, 8)))
    await until(() => back.signals.includes('checkpoint 1 1'))
    await leave(room, back, bytes(8, 8))
    const again = await hostOf(room, '3600', { after: 0 })
    await until(() => again.binary.length === 2)
    expect(kinds(again)).toEqual([Kind.Replay, Kind.LogEnd])
    expect([...again.binary[0]!.subarray(1)]).toEqual([8, 8])
    expect(decodeUint64(again.binary[1]!.subarray(1))).toBe(1)
    await leave(room, again, bytes(8, 8))
    const current = await hostOf(room, '3600', { after: 1 })
    await until(() => current.binary.length === 1)
    expect(kinds(current)).toEqual([Kind.LogEnd])
  })
})

describe('a host that drops', () => {
  const endGrace = (room: Room) =>
    inRoom(room, (_, st) => {
      st.storage.kv.put('hostAwayUntil', Date.now() - 1)
    })

  it('gets the grace period first, then the room is kept', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    const guest = await join(room)
    h.ws.send(withKind(Kind.Snapshot, bytes(9)))
    h.ws.send(withKind(Kind.Live, bytes(1)))
    await until(() => guest.binary.length === 1)
    h.ws.close(1001, 'gone')
    await until(() => guest.signals.includes('host away'))
    expect((await state(room)).until).toBeUndefined()
    // Entries in the grace period are not logged.
    guest.ws.send(withKind(Kind.Entry, bytes(2)))
    await quiet()
    expect((await state(room)).log.tail).toBe(0)

    await endGrace(room)
    expect(await runDurableObjectAlarm(stubOf(room))).toBe(true)
    await until(() => guest.signals.some((s) => s.startsWith('kept ')))
    expect(await closedWithin(guest)).toBeUndefined()
    expect((await state(room)).until).toBeGreaterThan(Date.now())
    guest.ws.send(withKind(Kind.Entry, bytes(3)))
    await until(() => guest.binary.length === 2)
    expect(kinds(guest)).toEqual([Kind.Live, Kind.Logged])
  })

  it('ends the room as today when it left no snapshot', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    const guest = await join(room)
    h.ws.close(1001, 'gone')
    await until(() => guest.signals.includes('host away'))
    await endGrace(room)
    await runDurableObjectAlarm(stubOf(room))
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
  })

  it('ends the room as today when it leaves on purpose without a snapshot', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    const guest = await join(room)
    h.ws.close(HOST_LEFT, 'bye')
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
  })
})

describe('a kept room and the clients and deploys that meet it', () => {
  it('keeps the entries when a version 5 host comes back, and tells it to update', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    const guest = await join(room)
    await leave(room, h)
    guest.ws.send(withKind(Kind.Entry, bytes(10)))
    await until(() => guest.binary.length === 1)
    const old = await join(room, { host: true, version: 5 })
    expect((await old.closed).code).toBe(CLIENT_OUTDATED)
    expect(old.binary).toHaveLength(0)
    const s = await state(room)
    expect([s.until === undefined, s.keep, s.log.tail]).toEqual([false, 3600, 1])
    expect(guest.signals).not.toContain('host back')
    // The current host takes them in.
    const back = await hostOf(room, '3600', { after: 0 })
    await until(() => back.binary.length === 2)
  })

  it('gives a host that a deploy dropped its grace period and then keeps the room', async () => {
    const room = await createRoom()
    const h = await hostOf(room)
    h.ws.send(withKind(Kind.Snapshot, bytes(9)))
    await expect.poll(async () => (await state(room)).snapshot).toBe(true)
    // No close callback ran, and no guest came: only the alarm finds out.
    await evictDurableObject(stubOf(room), { webSockets: 'close' })
    expect(await runDurableObjectAlarm(stubOf(room))).toBe(true)
    expect((await state(room)).snapshot).toBe(true)
    const grace = await inRoom(room, (_, st) => st.storage.kv.get<number>('hostAwayUntil'))
    expect(grace).toBeGreaterThan(Date.now())
    await inRoom(room, (_, st) => {
      st.storage.kv.put('hostAwayUntil', Date.now() - 1)
    })
    await runDurableObjectAlarm(stubOf(room))
    expect((await state(room)).until).toBeGreaterThan(Date.now())
  })

  it('fixes the keep at the first connection, with every image under kept/', async () => {
    const room = await createRoom()
    const url = `https://pedit.test/api/rooms/${room.id}/blobs/${'A'.repeat(22)}`
    const h = await hostOf(room, '3600')
    const put = await exports.default.fetch(url, {
      method: 'PUT',
      body: bytes(1),
      headers: { [ADMISSION_HEADER]: room.admission },
    })
    expect(put.status).toBe(201)
    const id = env.ROOM.idFromName(room.id).toString()
    expect((await env.BLOBS.list({ prefix: `kept/${id}/` })).objects).toHaveLength(1)
    expect((await env.BLOBS.list({ prefix: `rooms/${id}/` })).objects).toHaveLength(0)
    h.ws.close(1001, 'gone')
    await h.closed
    // A later connect cannot change it: it is answered with the stored keep.
    const again = await hostOf(room, '60')
    await until(() => again.signals.length === 1)
    expect(again.signals).toEqual(['keep 3600 0'])
    expect((await state(room)).keep).toBe(3600)
    const get = await exports.default.fetch(url, {
      headers: { [ADMISSION_HEADER]: room.admission },
    })
    expect(get.status).toBe(200)
    // A room first connected without a keep cannot gain one.
    const plain = await createRoom()
    await join(plain, { host: true })
    const late = await hostOf(plain, '3600')
    await until(() => late.signals.length === 1)
    expect(late.signals).toEqual(['keep 0 0'])
  })
})

describe('the end of a kept room', () => {
  async function kept() {
    const room = await createRoom()
    const h = await hostOf(room)
    const guest = await join(room)
    const reader = await join(room, { reader: true })
    const url = `https://pedit.test/api/rooms/${room.id}/blobs/${'B'.repeat(22)}`
    await leave(room, h)
    await until(() => guest.signals.length === 1)
    guest.ws.send(withKind(Kind.Entry, bytes(10)))
    await until(() => guest.binary.length === 1)
    const put = await exports.default.fetch(url, {
      method: 'PUT',
      body: bytes(1),
      headers: { [ADMISSION_HEADER]: room.admission },
    })
    expect(put.status).toBe(201)
    const blobs = async () =>
      (await env.BLOBS.list({ prefix: `kept/${env.ROOM.idFromName(room.id).toString()}/` })).objects
    expect(await blobs()).toHaveLength(1)
    return { room, guest, reader, blobs }
  }

  it('closes everyone with ROOM_EXPIRED at the deadline, and deletes what it kept', async () => {
    const { room, guest, reader, blobs } = await kept()
    await inRoom(room, (_, st) => {
      st.storage.kv.put('keptAwayUntil', Date.now() - 1)
    })
    expect(await runDurableObjectAlarm(stubOf(room))).toBe(true)
    expect((await guest.closed).code).toBe(ROOM_EXPIRED)
    expect((await reader.closed).code).toBe(ROOM_EXPIRED)
    const s = await state(room)
    expect([s.until, s.snapshot, s.log, s.rows]).toEqual([
      undefined,
      false,
      { tail: 0, cutoff: 0 },
      0,
    ])
    expect(await blobs()).toEqual([])
    // The ID is not opened again, by the host or anyone.
    const res = await join(room, { host: true, keep: '3600' }).then(
      (p) => p.closed,
      () => undefined,
    )
    expect(res?.code).toBe(ROOM_EXPIRED)
    expect((await state(room)).opened).toBeDefined()
  })

  it('ends at a message that comes after the deadline when the alarm is late', async () => {
    const { room, guest } = await kept()
    await inRoom(room, (_, st) => {
      st.storage.kv.put('keptAwayUntil', Date.now() - 1)
    })
    guest.ws.send(withKind(Kind.Entry, bytes(1)))
    expect((await guest.closed).code).toBe(ROOM_EXPIRED)
    expect((await state(room)).log.tail).toBe(0)
  })

  const close = (room: Room, tail: number | string, token = room.hostToken) =>
    exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/keep/close`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Pedit-Tail': String(tail),
        'CF-Connecting-IP': nextAddress(),
      },
    })

  it('is ended by the host with POST /keep/close, if it took in every entry', async () => {
    const { room, guest, reader, blobs } = await kept()
    expect((await close(room, 0)).status).toBe(409)
    expect((await close(room, 1, 'y'.repeat(43))).status).toBe(403)
    expect(await closedWithin(guest)).toBeUndefined()
    expect((await close(room, 1)).status).toBe(200)
    const ended = await guest.closed
    expect([ended.code, ended.reason]).toEqual([ROOM_CLOSED, 'the host closed the room'])
    expect((await reader.closed).code).toBe(ROOM_CLOSED)
    const s = await state(room)
    expect([s.until, s.snapshot, s.rows]).toEqual([undefined, false, 0])
    expect(await blobs()).toEqual([])
    // Again: nothing left to close.
    expect((await close(room, 1)).status).toBe(200)
  })
})
