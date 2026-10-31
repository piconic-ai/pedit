import {
  createExecutionContext,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test'
import { env, exports } from 'cloudflare:workers'
import {
  ADMISSION_HEADER,
  admissionProtocols,
  READ_ADMISSION_HEADER,
} from '@pedit/protocol/admission'
import { expiredReason } from '@pedit/protocol/close'
import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { describe, expect, it, vi } from 'vitest'
import app, { clientKey, maintenance, overLimit, roomIdFor } from '../src/index.ts'
import {
  ALARM_INTERVAL_MS,
  BLOB_OVERHEAD,
  BYTE_RATE,
  limits,
  MAX_PEERS,
  MAX_UPLOADS,
  MESSAGE_RATE,
  RATE_LIMITED,
  type Room as RoomObject,
} from '../src/room.ts'

const ROOM_CLOSED = 4001
const CLIENT_OUTDATED = 4002
const SERVER_OUTDATED = 4003
const ROOM_FULL = 4004
const RELAY_BUSY = 4005
const RELAY_MAINTENANCE = 4006
const ROOM_EXPIRED = 4007
const HOST_LEFT = 4008
const MESSAGE_TOO_BIG = 1009
// The tests run with small limits (vitest.config.ts).
const { guests: GUESTS, readers: READERS, blobBytes: BLOB_BYTES, roomSeconds } = limits(env)
const LIFETIME_MS = roomSeconds * 1000

interface Room {
  id: string
  hostToken: string
  /** The editor admission token, and the readers' (comment-only and read-only links). */
  admission: string
  read: string
}

// These tests speak protocol version 5, which has no kind byte: the relay
// still serves it. kept-away.test.ts speaks version 6.
const legacyProtocols = (token: string) => admissionProtocols(token, 5)

const admissions = new Map<string, string>()

// Each request comes from an address of its own unless a test says otherwise,
// so the per-network rate limits only count what a test means them to.
let lastAddress = 0
const nextAddress = () => {
  lastAddress++
  return `10.${(lastAddress >> 16) & 255}.${(lastAddress >> 8) & 255}.${lastAddress & 255}`
}

const postRoom = (ip = nextAddress()) =>
  exports.default.fetch('https://pedit.test/api/rooms', {
    method: 'POST',
    headers: { 'CF-Connecting-IP': ip },
  })

async function createRoom(): Promise<Room> {
  const res = await postRoom()
  expect(res.status).toBe(201)
  const room = await res.json<Room>()
  room.admission = crypto.randomUUID().replaceAll('-', '') + 'A'.repeat(11)
  room.read = crypto.randomUUID().replaceAll('-', '') + 'R'.repeat(11)
  admissions.set(room.id, room.admission)
  return room
}

interface Peer {
  ws: WebSocket
  received: ArrayBuffer[]
  /** What the relay itself said (HOST_AWAY, HOST_BACK). */
  signals: string[]
  closed: Promise<CloseEvent>
}

function upgrade(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`https://pedit.test/api/rooms/${id}/ws`, {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': legacyProtocols(admissions.get(id)!).join(', '),
      'CF-Connecting-IP': nextAddress(),
      ...headers,
    },
  })
}

async function connect(id: string, headers: Record<string, string> = {}): Promise<Peer> {
  const res = await upgrade(id, headers)
  expect(res.status).toBe(101)
  const ws = res.webSocket
  if (!ws) throw new Error('no websocket')
  const received: ArrayBuffer[] = []
  const signals: string[] = []
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
  ws.addEventListener('message', (ev) => {
    if (ev.data instanceof ArrayBuffer) received.push(ev.data)
    else if (typeof ev.data === 'string') signals.push(ev.data)
  })
  ws.binaryType = 'arraybuffer'
  ws.accept()
  return { ws, received, signals, closed }
}

const host = (room: Room, headers: Record<string, string> = {}) =>
  connect(room.id, {
    Authorization: `Bearer ${room.hostToken}`,
    [READ_ADMISSION_HEADER]: room.read,
    ...headers,
  })

/** The upgrade headers of a guest with a comment-only or read-only link. */
const asReader = (room: Room) => ({
  'Sec-WebSocket-Protocol': legacyProtocols(room.read).join(', '),
})

/**
 * Stops the room's clock at 0 and returns a way to move it, so a test decides
 * how much the allowances refill however slowly its messages are relayed.
 */
async function stopClock(room: Room): Promise<(ms: number) => void> {
  let now = 0
  const stub = env.ROOM.get(env.ROOM.idFromName(room.id))
  await runInDurableObject(stub, (instance: RoomObject) => {
    instance['now'] = () => now
  })
  return (ms) => {
    now += ms
  }
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(check()).toBe(true)
}

describe('rooms', () => {
  it('rejects keyless clients before they consume peer slots', async () => {
    const room = await createRoom()
    await host(room)
    for (let i = 0; i < MAX_PEERS + 1; i++) {
      expect((await upgrade(room.id, { 'Sec-WebSocket-Protocol': '' })).status).toBe(403)
    }
    const wrong = legacyProtocols('B'.repeat(43)).join(', ')
    expect((await upgrade(room.id, { 'Sec-WebSocket-Protocol': wrong })).status).toBe(403)
    expect(
      (await upgrade(room.id, { 'Sec-WebSocket-Protocol': wrong, 'X-Pedit-Host': '1' })).status,
    ).toBe(403)
    const valid = await upgrade(room.id)
    expect(valid.status).toBe(101)
    expect(valid.headers.get('Sec-WebSocket-Protocol')).toBe('pedit-v5')
    valid.webSocket?.accept()
    valid.webSocket?.close()
  })

  it('lets in browsers of its own origin and clients without one, and no other', async () => {
    const room = await createRoom()
    await host(room, { Origin: 'https://pedit.test' })
    const guest = await connect(room.id, { Origin: 'https://pedit.test' })
    guest.ws.close()
    for (const origin of ['https://evil.example', 'http://pedit.test', 'null']) {
      const res = await upgrade(room.id, { Origin: origin })
      expect(res.status).toBe(403)
      expect(await res.text()).toBe('cross-origin WebSocket not allowed')
    }
  })

  it('tells clients of another protocol version to update, before admission', async () => {
    const room = await createRoom()
    await host(room)
    const admission = legacyProtocols(admissions.get(room.id)!)[1]
    // pedit-v4 is a pedit from before peers signed their frames.
    const old = await upgrade(room.id, { 'Sec-WebSocket-Protocol': `pedit-v4, ${admission}` })
    expect(old.status).toBe(101)
    expect(old.headers.get('Sec-WebSocket-Protocol')).toBe('pedit-v4')
    // A wrong admission makes no difference: the version is checked first.
    const newer = await connect(room.id, {
      'Sec-WebSocket-Protocol': `pedit-v7, pedit-admission.${'B'.repeat(43)}`,
    })
    expect((await newer.closed).code).toBe(SERVER_OUTDATED)
    const ws = old.webSocket!
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
    ws.accept()
    expect((await closed).code).toBe(CLIENT_OUTDATED)
    // Neither took a peer slot or registered anything.
    const guest = await connect(room.id)
    guest.ws.close()
  })

  it('only lets the host register admission and preserves it across hibernation', async () => {
    const room = await createRoom()
    const attacker = await connect(room.id, {
      'Sec-WebSocket-Protocol': legacyProtocols('B'.repeat(43)).join(', '),
    })
    expect((await attacker.closed).code).toBe(ROOM_CLOSED)
    await host(room)
    const stub = env.ROOM.get(env.ROOM.idFromName(room.id))
    await evictDurableObject(stub)
    await connect(room.id)
    expect(
      (
        await upgrade(room.id, {
          'Sec-WebSocket-Protocol': legacyProtocols('B'.repeat(43)).join(', '),
        })
      ).status,
    ).toBe(403)
    // Even an authenticated host cannot change the token during this session.
    expect(
      (
        await upgrade(room.id, {
          Authorization: `Bearer ${room.hostToken}`,
          'Sec-WebSocket-Protocol': legacyProtocols('B'.repeat(43)).join(', '),
        })
      ).status,
    ).toBe(403)
  })

  it('issues unguessable room ids derived from the host token', async () => {
    const a = await createRoom()
    const b = await createRoom()
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.id).toBe(await roomIdFor(a.hostToken))
    expect(a.id).not.toBe(b.id)
  })

  it('rejects malformed ids, plain requests and wrong host tokens', async () => {
    expect((await exports.default.fetch('https://pedit.test/api/rooms/nope/ws')).status).toBe(400)
    const room = await createRoom()
    expect((await exports.default.fetch(`https://pedit.test/api/rooms/${room.id}/ws`)).status).toBe(
      426,
    )
    const other = await createRoom()
    const res = await upgrade(room.id, { Authorization: `Bearer ${other.hostToken}` })
    expect(res.status).toBe(403)
  })

  it('relays binary frames to everyone but the sender', async () => {
    const room = await createRoom()
    const a = await host(room)
    const b = await connect(room.id)
    const c = await connect(room.id)
    a.ws.send(new Uint8Array([1, 2, 3]))
    await until(() => b.received.length === 1 && c.received.length === 1)
    expect([...new Uint8Array(b.received[0] ?? new ArrayBuffer(0))]).toEqual([1, 2, 3])
    expect(a.received).toHaveLength(0)
    b.ws.send(new Uint8Array([4]))
    await until(() => a.received.length === 1)
  })

  it('does not replay earlier frames to a guest who joins later', async () => {
    const room = await createRoom()
    const h = await host(room)
    const first = await connect(room.id)
    h.ws.send(new Uint8Array([1]))
    await until(() => first.received.length === 1)

    const late = await connect(room.id)
    h.ws.send(new Uint8Array([2]))
    await until(() => late.received.length === 1)
    expect([...new Uint8Array(late.received[0] ?? new ArrayBuffer(0))]).toEqual([2])
  })

  it('keeps rooms isolated', async () => {
    const one = await createRoom()
    const two = await createRoom()
    const a = await host(one)
    const other = await host(two)
    const b = await connect(two.id)
    a.ws.send(new Uint8Array([9]))
    await new Promise((r) => setTimeout(r, 50))
    expect(other.received).toHaveLength(0)
    expect(b.received).toHaveLength(0)
  })

  it('turns guests away while there is no host', async () => {
    const room = await createRoom()
    const guest = await connect(room.id)
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
  })

  it('ignores a role header sent by a client', async () => {
    const room = await createRoom()
    const guest = await connect(room.id, { 'X-Pedit-Host': '1' })
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
  })

  it('closes the room for everyone when the host leaves', async () => {
    const room = await createRoom()
    const h = await host(room)
    const a = await connect(room.id)
    const b = await connect(room.id)
    h.ws.close(HOST_LEFT, 'bye')
    expect((await a.closed).code).toBe(ROOM_CLOSED)
    expect((await b.closed).code).toBe(ROOM_CLOSED)
    const late = await connect(room.id)
    expect((await late.closed).code).toBe(ROOM_CLOSED)
  })

  it('logs why a session ended, without the room ID of the link or its secrets', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    try {
      const room = await createRoom()
      const h = await host(room)
      const guest = await connect(room.id)
      h.ws.close(HOST_LEFT, 'bye')
      expect((await guest.closed).code).toBe(ROOM_CLOSED)
      const late = await connect(room.id)
      expect((await late.closed).code).toBe(ROOM_CLOSED)

      const events = lines.map((l) => JSON.parse(l)).filter((e) => e.message?.startsWith('room: '))
      const named = (m: string) => events.find((e) => e.message === `room: ${m}`)
      expect(named('host connected')).toMatchObject({ hosts: 1, guests: 0 })
      expect(named('host closed')).toMatchObject({ code: HOST_LEFT, wasClean: true, otherHosts: 0 })
      expect(named('session ended')).toMatchObject({ code: ROOM_CLOSED, reason: 'the host left' })
      expect(named('turned a guest away')).toMatchObject({ code: ROOM_CLOSED, hosts: 0 })
      const room0 = named('host connected').room
      expect(events.every((e) => e.room === room0)).toBe(true)
      for (const line of lines) {
        for (const secret of [room.id, room.hostToken, room.admission]) {
          expect(line).not.toContain(secret)
        }
      }
    } finally {
      spy.mockRestore()
    }
  })

  it('logs a connection the relay closes itself', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    try {
      const room = await createRoom()
      await host(room)
      const text = await connect(room.id)
      text.ws.send('hello')
      expect((await text.closed).code).toBe(1003)
      const events = lines.map((l) => JSON.parse(l))
      expect(events).toContainEqual(
        expect.objectContaining({ message: 'room: closed a peer', code: 1003, host: false }),
      )
    } finally {
      spy.mockRestore()
    }
  })

  it('stays open while a reconnected host is still there', async () => {
    const room = await createRoom()
    const stale = await host(room)
    await host(room)
    const guest = await connect(room.id)
    stale.ws.close(1000, 'replaced')
    await new Promise((r) => setTimeout(r, 50))
    guest.ws.send(new Uint8Array([1]))
    const closedEarly = await Promise.race([
      guest.closed.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 50)),
    ])
    expect(closedEarly).toBe(false)
  })

  it('answers a ping of the room itself, the one text frame it takes', async () => {
    const room = await createRoom()
    const h = await host(room)
    h.ws.send('pedit ping')
    await until(() => h.signals.includes('pedit pong'))
    const closedEarly = await Promise.race([
      h.closed.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 50)),
    ])
    expect(closedEarly).toBe(false)
  })

  it('closes sockets that send text or oversized frames', async () => {
    const room = await createRoom()
    const h = await host(room)
    const text = await connect(room.id)
    text.ws.send('hello')
    expect((await text.closed).code).toBe(1003)

    // The most a frame may have is relayed; one byte more is not.
    const fits = await connect(room.id)
    fits.ws.send(new Uint8Array(MAX_FRAME_BYTES))
    await until(() => h.received.some((m) => m.byteLength === MAX_FRAME_BYTES))

    const big = await connect(room.id)
    big.ws.send(new Uint8Array(MAX_FRAME_BYTES + 1))
    expect((await big.closed).code).toBe(MESSAGE_TOO_BIG)
  })

  it('turns guests away once the room has as many as the relay allows', async () => {
    const room = await createRoom()
    await host(room)
    const first = await connect(room.id)
    for (let i = 1; i < GUESTS; i++) await connect(room.id)
    const late = await connect(room.id)
    const closed = await late.closed
    expect(closed.code).toBe(ROOM_FULL)
    expect(closed.reason).toBe('room is full')
    // The host is not a guest: a reconnecting host still gets in.
    const again = await host(room)
    expect(again.ws.readyState).toBe(WebSocket.OPEN)
    // Someone leaving frees their place.
    first.ws.close(HOST_LEFT, 'bye')
    await first.closed
    await vi.waitFor(async () => {
      const next = await connect(room.id)
      expect(next.ws.readyState).toBe(WebSocket.OPEN)
    })
  })

  it('admits comment-only and read-only links in places of their own', async () => {
    const room = await createRoom()
    await host(room)
    for (let i = 0; i < READERS; i++) await connect(room.id, asReader(room))
    const late = await connect(room.id, asReader(room))
    expect((await late.closed).code).toBe(ROOM_FULL)
    // Readers do not take editors' places.
    const editor = await connect(room.id)
    expect(editor.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('admits readers only when the host registered their token', async () => {
    const room = await createRoom()
    await host(room, { [READ_ADMISSION_HEADER]: '' })
    expect((await upgrade(room.id, asReader(room))).status).toBe(403)
    // Only the host may register it: a guest's header does nothing.
    const other = await createRoom()
    await host(other)
    const spoof = await upgrade(other.id, {
      'Sec-WebSocket-Protocol': legacyProtocols('B'.repeat(43)).join(', '),
      [READ_ADMISSION_HEADER]: 'B'.repeat(43),
    })
    expect(spoof.status).toBe(403)
    expect((await upgrade(room.id, { [READ_ADMISSION_HEADER]: 'bad' })).status).toBe(101)
  })

  it('caps the number of connections', async () => {
    const room = await createRoom()
    for (let i = 0; i < MAX_PEERS; i++) await host(room)
    expect((await (await host(room)).closed).code).toBe(ROOM_FULL)
  })

  it('keeps every editor place while readers fill theirs', async () => {
    const room = await createRoom()
    for (let i = 0; i < MAX_PEERS - 1; i++) await host(room)
    const readers: Peer[] = []
    for (let i = 0; i < READERS; i++) readers.push(await connect(room.id, asReader(room)))
    const last = await host(room)
    expect((await (await host(room)).closed).code).toBe(ROOM_FULL)
    // Sockets the room refused have closed by now, as the one above did.
    for (const peer of [...readers, last]) expect(peer.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('reads its limits from the Worker vars, within the defaults', () => {
    expect(limits({})).toEqual({
      guests: MAX_PEERS - 1,
      readers: MAX_PEERS - 1,
      blobBytes: 10 * 1024 * 1024,
      quotaBytes: 100 * 1024 * 1024,
      quotaCount: 500,
      roomSeconds: Number.POSITIVE_INFINITY,
      lifeSeconds: 7 * 86400,
      hostGraceSeconds: 120,
    })
    expect(limits({ ROOM_MAX_SECONDS: '86400' }).roomSeconds).toBe(86400)
    expect(limits({ ROOM_LIFE_SECONDS: '3600' }).lifeSeconds).toBe(3600)
    expect(limits({ ROOM_LIFE_SECONDS: 'x' }).lifeSeconds).toBe(604800)
    expect(limits({ HOST_GRACE_SECONDS: '30' }).hostGraceSeconds).toBe(30)
    for (const bad of ['0', '-1', '1.5', 'many', '']) {
      expect(limits({ HOST_GRACE_SECONDS: bad }).hostGraceSeconds).toBe(120)
    }
    for (const bad of ['0', '-1', '1.5', 'many', '']) {
      expect(limits({ ROOM_MAX_SECONDS: bad }).roomSeconds).toBe(Number.POSITIVE_INFINITY)
    }
    expect(limits({ ROOM_GUESTS: '100' }).guests).toBe(MAX_PEERS - 1)
    // Readers take as many places as guests unless set apart.
    expect(limits({ ROOM_GUESTS: '4' }).readers).toBe(4)
    expect(limits({ ROOM_GUESTS: '4', ROOM_READERS: '10' }).readers).toBe(10)
    expect(limits({ ROOM_READERS: '100' }).readers).toBe(MAX_PEERS - 1)
    for (const bad of ['0', '-1', '1.5', 'many']) {
      expect(limits({ ROOM_GUESTS: bad, BLOB_MAX_BYTES: bad }).guests).toBe(MAX_PEERS - 1)
      expect(limits({ BLOB_MAX_BYTES: bad }).blobBytes).toBe(10 * 1024 * 1024)
    }
  })

  it('closes a connection that sends too many messages', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    await stopClock(room)
    for (let i = 0; i <= MESSAGE_RATE.burst; i++) guest.ws.send(new Uint8Array(1))
    expect((await guest.closed).code).toBe(RATE_LIMITED)
    // The burst itself was relayed, and nobody else was cut off. Relaying a
    // whole burst can take seconds on a busy machine, as in the test below.
    await vi.waitFor(() => expect(h.received.length).toBe(MESSAGE_RATE.burst), { timeout: 10_000 })
    expect(h.ws.readyState).toBe(WebSocket.OPEN)
  }, 30_000)

  it('closes a connection that sends too many bytes', async () => {
    const room = await createRoom()
    await host(room)
    const guest = await connect(room.id)
    await stopClock(room)
    const big = new Uint8Array(MAX_FRAME_BYTES)
    for (let i = 0; i <= BYTE_RATE.burst / MAX_FRAME_BYTES; i++) guest.ws.send(big)
    expect((await guest.closed).code).toBe(RATE_LIMITED)
  })

  it('lets a steady sender keep going', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    const tick = await stopClock(room)
    // The whole burst, then a second's worth of messages each second. Each
    // batch is relayed before the clock moves, so it all counts against the
    // allowance at the time it was sent.
    const relayed = (n: number) =>
      vi.waitFor(() => expect(h.received.length).toBe(n), { timeout: 10_000 })
    for (let i = 0; i < MESSAGE_RATE.burst; i++) guest.ws.send(new Uint8Array(1))
    let total = MESSAGE_RATE.burst
    await relayed(total)
    for (let second = 0; second < 2; second++) {
      tick(1000)
      for (let i = 0; i < MESSAGE_RATE.perSecond; i++) guest.ws.send(new Uint8Array(1))
      total += MESSAGE_RATE.perSecond
      await relayed(total)
    }
    expect(guest.ws.readyState).toBe(WebSocket.OPEN)
  }, 30_000)
})

// A blob id: 22 base64url characters.
const blobId = (n: number) => `blob${String(n).padStart(18, '0')}`

function blobUrl(room: Room | string, id: string): string {
  return `https://pedit.test/api/rooms/${typeof room === 'string' ? room : room.id}/blobs/${id}`
}

const putBlob = (room: Room, id: string, body: Uint8Array<ArrayBuffer>) =>
  exports.default.fetch(blobUrl(room, id), {
    method: 'PUT',
    body,
    headers: { [ADMISSION_HEADER]: room.admission },
  })

const getBlob = (room: Room, id: string) =>
  exports.default.fetch(blobUrl(room, id), { headers: { [ADMISSION_HEADER]: room.admission } })

/** A PUT whose body arrives only when finish() is called. */
function slowPut(room: Room, id: string, size: number) {
  const { readable, writable } = new FixedLengthStream(size)
  const res = exports.default.fetch(blobUrl(room, id), {
    method: 'PUT',
    body: readable,
    headers: { [ADMISSION_HEADER]: room.admission },
  })
  return {
    // The request has reached the room and claimed the id. Looked at from
    // inside: any probe from outside would take an upload slot itself.
    started: () =>
      vi.waitFor(() =>
        runInDurableObject(env.ROOM.get(env.ROOM.idFromName(room.id)), (instance: RoomObject) =>
          expect([...instance['uploading']].some((key) => key.endsWith(`/${id}`))).toBe(true),
        ),
      ),
    finish: async () => {
      const writer = writable.getWriter()
      await writer.write(new Uint8Array(size))
      await writer.close()
      return res
    },
  }
}

// Blobs live under the room's Durable Object id.
async function roomBlobs(room: Room): Promise<string[]> {
  const prefix = `rooms/${env.ROOM.idFromName(room.id).toString()}/`
  return (await env.BLOBS.list({ prefix })).objects.map((o) => o.key)
}

describe('blobs', () => {
  it('never takes a request to a blob path as a host connection', async () => {
    const room = await createRoom()
    // %41 is A: the Worker's route decodes it, so the id looks valid there.
    const id = `%41${'A'.repeat(21)}`
    const res = await exports.default.fetch(blobUrl(room, id), {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': legacyProtocols('B'.repeat(43)).join(', '),
        'X-Pedit-Host': '1',
      },
    })
    expect(res.status).not.toBe(101)
    res.webSocket?.close()
    // The room still has no admission verifier, so its real host gets in.
    await host(room)
  })

  it('serves a blob whose id has percent-encoded characters', async () => {
    const room = await createRoom()
    await host(room)
    expect((await putBlob(room, `%41${'A'.repeat(21)}`, new Uint8Array([7]))).status).toBe(201)
    const res = await getBlob(room, 'A'.repeat(22))
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7]))
  })

  it('rejects missing and wrong admission without consuming blob quota', async () => {
    const room = await createRoom()
    await host(room)
    for (const token of ['', 'B'.repeat(43)]) {
      for (let i = 0; i < 4; i++) {
        expect(
          (
            await exports.default.fetch(blobUrl(room, blobId(i)), {
              method: 'PUT',
              body: new Uint8Array(),
              headers: { [ADMISSION_HEADER]: token, 'X-Pedit-Host': '1' },
            })
          ).status,
        ).toBe(403)
      }
      expect(
        (
          await exports.default.fetch(blobUrl(room, blobId(0)), {
            headers: { [ADMISSION_HEADER]: token },
          })
        ).status,
      ).toBe(403)
    }
    expect(await roomBlobs(room)).toEqual([])
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(201)
    expect((await getBlob(room, blobId(1))).status).toBe(200)
  })

  it('lets readers fetch images but not add them', async () => {
    const room = await createRoom()
    await host(room)
    const asReaderBlob = { [ADMISSION_HEADER]: room.read }
    const put = await exports.default.fetch(blobUrl(room, blobId(1)), {
      method: 'PUT',
      body: new Uint8Array(90),
      headers: asReaderBlob,
    })
    expect(put.status).toBe(403)
    expect(await put.text()).toBe('adding images needs an edit link')
    expect(await roomBlobs(room)).toEqual([])
    expect((await putBlob(room, blobId(1), new Uint8Array([1, 2]))).status).toBe(201)
    const got = await exports.default.fetch(blobUrl(room, blobId(1)), { headers: asReaderBlob })
    expect(got.status).toBe(200)
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([1, 2])
  })

  it('stores and serves blobs while the host is connected', async () => {
    const room = await createRoom()
    await host(room)
    expect((await putBlob(room, blobId(1), new Uint8Array([1, 2, 3]))).status).toBe(201)
    const res = await getBlob(room, blobId(1))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(res.headers.get('Cache-Control')).toContain('private')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3])
    expect((await getBlob(room, blobId(2))).status).toBe(404)
  })

  it('keeps the first upload under an id', async () => {
    const room = await createRoom()
    await host(room)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    expect((await putBlob(room, blobId(1), new Uint8Array([2]))).status).toBe(200)
    const res = await getBlob(room, blobId(1))
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1])
  })

  it('keeps rooms apart', async () => {
    const one = await createRoom()
    const two = await createRoom()
    await host(one)
    await host(two)
    await putBlob(one, blobId(1), new Uint8Array([1]))
    expect((await getBlob(two, blobId(1))).status).toBe(404)
  })

  it('refuses blobs while there is no host', async () => {
    const room = await createRoom()
    expect((await putBlob(room, blobId(1), new Uint8Array([1]))).status).toBe(410)
    expect((await getBlob(room, blobId(1))).status).toBe(410)
  })

  it('rejects malformed ids, other methods and oversized blobs', async () => {
    const room = await createRoom()
    await host(room)
    expect((await exports.default.fetch(blobUrl(room, 'short'))).status).toBe(400)
    expect((await exports.default.fetch(blobUrl('nope', blobId(1)))).status).toBe(400)
    const del = await exports.default.fetch(blobUrl(room, blobId(1)), {
      method: 'DELETE',
      headers: { [ADMISSION_HEADER]: room.admission },
    })
    expect(del.status).toBe(405)
    const big = await putBlob(room, blobId(1), new Uint8Array(BLOB_BYTES + BLOB_OVERHEAD + 1))
    expect(big.status).toBe(413)
    const fits = await putBlob(room, blobId(2), new Uint8Array(BLOB_BYTES))
    expect(fits.status).toBe(201)
    // A stream of unknown length is sent without Content-Length.
    const { readable, writable } = new TransformStream()
    const unsized = exports.default.fetch(blobUrl(room, blobId(1)), {
      method: 'PUT',
      headers: { [ADMISSION_HEADER]: room.admission },
      body: readable,
    })
    await writable.close()
    expect((await unsized).status).toBe(411)
  })

  it('refuses a second upload of an id while the first is in flight', async () => {
    const room = await createRoom()
    await host(room)
    const first = slowPut(room, blobId(1), 4)
    await first.started()
    expect((await putBlob(room, blobId(1), new Uint8Array(4))).status).toBe(409)
    expect((await first.finish()).status).toBe(201)
    expect((await putBlob(room, blobId(1), new Uint8Array(4))).status).toBe(200)
  })

  it('takes only a few uploads at once', async () => {
    const room = await createRoom()
    await host(room)
    const slow = Array.from({ length: MAX_UPLOADS }, (_, i) => slowPut(room, blobId(i), 4))
    // Wait for every slow upload to reach the room, looking inside it: any
    // probe from outside would take an upload slot itself.
    const stub = env.ROOM.get(env.ROOM.idFromName(room.id))
    await vi.waitFor(() =>
      runInDurableObject(stub, (instance: RoomObject) =>
        expect(instance['uploading'].size).toBe(MAX_UPLOADS),
      ),
    )
    const busy = await putBlob(room, blobId(MAX_UPLOADS), new Uint8Array(4))
    expect(busy.status).toBe(503)
    expect(busy.headers.get('Retry-After')).toBe('1')
    for (const upload of slow) expect((await upload.finish()).status).toBe(201)
    expect((await putBlob(room, blobId(MAX_UPLOADS), new Uint8Array(4))).status).toBe(201)
  })

  it('waits out every cleanup before serving a new session', async () => {
    const room = await createRoom()
    const first = await host(room)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    // Two sessions end back to back; each chains a cleanup.
    first.ws.close(HOST_LEFT, 'bye')
    const second = await host(room)
    second.ws.close(HOST_LEFT, 'bye')
    await host(room)
    const res = await getBlob(room, blobId(1))
    expect(res.status).toBe(404)
    expect(await roomBlobs(room)).toEqual([])
  })

  it('drops an upload that outlives its session', async () => {
    const room = await createRoom()
    const h = await host(room)
    const upload = slowPut(room, blobId(1), 90)
    await upload.started()
    h.ws.close(HOST_LEFT, 'bye')
    await new Promise((r) => setTimeout(r, 50))
    await host(room)
    expect((await upload.finish()).status).toBe(410)
    expect(await roomBlobs(room)).toEqual([])
    // The ended session's reservation does not count against the new one.
    expect((await putBlob(room, blobId(2), new Uint8Array(90))).status).toBe(201)
  })

  it('enforces the room quota', async () => {
    // The tests run with a quota of 100 bytes and 5 blobs (vitest.config.ts).
    const room = await createRoom()
    await host(room)
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(201)
    expect((await putBlob(room, blobId(2), new Uint8Array(20))).status).toBe(429)
    expect((await putBlob(room, blobId(3), new Uint8Array(5))).status).toBe(201)
    expect((await putBlob(room, blobId(4), new Uint8Array(5))).status).toBe(201)
    expect((await putBlob(room, blobId(5), new Uint8Array(0))).status).toBe(201)
    expect((await putBlob(room, blobId(6), new Uint8Array(0))).status).toBe(201)
    expect((await putBlob(room, blobId(7), new Uint8Array(0))).status).toBe(429)
    // A repeated upload is free.
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(200)
  })

  it('deletes the blobs and the quota when the host leaves', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    await putBlob(room, blobId(2), new Uint8Array([2]))
    expect(await roomBlobs(room)).toHaveLength(2)

    h.ws.close(HOST_LEFT, 'bye')
    await guest.closed
    await vi.waitFor(async () => expect(await roomBlobs(room)).toEqual([]))
    expect((await getBlob(room, blobId(1))).status).toBe(410)

    // The next session starts with a fresh quota.
    await host(room)
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(201)
  })
})

// The emulated rate limits count in windows aligned to the wall clock's
// minutes, so a test that fills one must not straddle a minute boundary.
async function withinOneWindow() {
  const left = 60_000 - (Date.now() % 60_000)
  if (left < 10_000) await new Promise((r) => setTimeout(r, left + 50))
}

describe('rate limits', () => {
  it('counts a client by its address, and IPv6 by its /64', () => {
    const key = (ip?: string) =>
      clientKey(
        new Request('https://pedit.test', { headers: ip ? { 'CF-Connecting-IP': ip } : {} }),
      )
    expect(key('203.0.113.7')).toBe('203.0.113.7')
    expect(key('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(key('2001:DB8:0001:0002::9')).toBe('2001:db8:1:2::/64')
    expect(key('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(key('::1')).toBe('0:0:0:0::/64')
    expect(key()).toBe('unknown')
  })

  it('limits nothing without the binding', async () => {
    expect(await overLimit(undefined, new Request('https://pedit.test'), 'test')).toBe(false)
  })

  it('turns away a network that creates too many rooms', { timeout: 20_000 }, async () => {
    await withinOneWindow()
    const ip = nextAddress()
    for (let i = 0; i < 20; i++) expect((await postRoom(ip)).status).toBe(201)
    const res = await postRoom(ip)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(await res.text()).toMatch(/Try again in a minute/)
    // Other networks are not held back.
    expect((await postRoom()).status).toBe(201)
  })

  it('counts an IPv6 network as one', { timeout: 20_000 }, async () => {
    await withinOneWindow()
    for (let i = 0; i < 20; i++) expect((await postRoom(`2001:db8:5::${i + 1}`)).status).toBe(201)
    expect((await postRoom('2001:db8:5::ffff')).status).toBe(429)
    expect((await postRoom('2001:db8:6::1')).status).toBe(201)
  })

  it('tells a network that connects too often to come back later', async () => {
    await withinOneWindow()
    const room = await createRoom()
    await host(room)
    const ip = nextAddress()
    // Turned away by the Worker for a wrong host token, after being counted.
    const turnedAway = await Promise.all(
      Array.from({ length: 60 }, () =>
        upgrade(room.id, { 'CF-Connecting-IP': ip, Authorization: 'Bearer wrong' }),
      ),
    )
    expect(turnedAway.map((r) => r.status)).toEqual(Array(60).fill(403))
    const res = await upgrade(room.id, { 'CF-Connecting-IP': ip })
    expect(res.status).toBe(101)
    expect(res.headers.get('Sec-WebSocket-Protocol')).toBe('pedit-v5')
    const ws = res.webSocket as WebSocket
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
    ws.accept()
    expect((await closed).code).toBe(RELAY_BUSY)
    // Another network still gets in.
    const other = await connect(room.id)
    expect(other.ws.readyState).toBe(WebSocket.OPEN)
  }, 20_000)
})

describe('maintenance', () => {
  // The Worker as deployed with MAINTENANCE set to level.
  const under = (level: string) => (request: Request) =>
    app.fetch(request, { ...env, MAINTENANCE: level }, createExecutionContext())

  it('reads the level, treating anything unknown as none', () => {
    expect(maintenance({})).toBe('none')
    expect(maintenance({ MAINTENANCE: 'no-new-rooms' })).toBe('no-new-rooms')
    expect(maintenance({ MAINTENANCE: ' closed ' })).toBe('closed')
    expect(maintenance({ MAINTENANCE: 'off' })).toBe('none')
  })

  it('takes no new rooms but keeps open ones going', async () => {
    const room = await createRoom()
    await host(room)
    const fetch = under('no-new-rooms')
    const res = await fetch(new Request('https://pedit.test/api/rooms', { method: 'POST' }))
    expect(res.status).toBe(503)
    expect(await res.text()).toMatch(/not taking new rooms.*self-hosting/)
    const guest = await fetch(
      new Request(`https://pedit.test/api/rooms/${room.id}/ws`, {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': legacyProtocols(room.admission).join(', '),
        },
      }),
    )
    expect(guest.status).toBe(101)
    guest.webSocket?.accept()
    const blob = await fetch(
      new Request(blobUrl(room, blobId(1)), {
        method: 'PUT',
        body: new Uint8Array([1]),
        headers: { [ADMISSION_HEADER]: room.admission },
      }),
    )
    expect(blob.status).toBe(201)
  })

  it('closes rooms that are still open at their next message', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    // As if Cloudflare kept the room running when the var changed.
    const stub = env.ROOM.get(env.ROOM.idFromName(room.id))
    await runInDurableObject(stub, (instance: RoomObject) => {
      instance['env'] = { ...instance['env'], MAINTENANCE: 'closed' } as Env
    })
    guest.ws.send(new Uint8Array(1))
    expect((await guest.closed).code).toBe(RELAY_MAINTENANCE)
    expect((await h.closed).code).toBe(RELAY_MAINTENANCE)
    expect(h.received).toHaveLength(0)
  })

  it('closes everything when closed', async () => {
    const room = await createRoom()
    await host(room)
    const fetch = under('closed')
    const create = await fetch(new Request('https://pedit.test/api/rooms', { method: 'POST' }))
    expect(create.status).toBe(503)
    expect(await create.text()).toMatch(/closed for maintenance/)
    const upgraded = await fetch(
      new Request(`https://pedit.test/api/rooms/${room.id}/ws`, {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': legacyProtocols(room.admission).join(', '),
          Authorization: `Bearer ${room.hostToken}`,
        },
      }),
    )
    expect(upgraded.status).toBe(101)
    expect(upgraded.headers.get('Sec-WebSocket-Protocol')).toBe('pedit-v5')
    const ws = upgraded.webSocket as WebSocket
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
    ws.accept()
    expect((await closed).code).toBe(RELAY_MAINTENANCE)
    const blob = await fetch(
      new Request(blobUrl(room, blobId(1)), { headers: { [ADMISSION_HEADER]: room.admission } }),
    )
    expect(blob.status).toBe(503)
  })
})

describe('room lifetime', () => {
  const stubOf = (room: Room) => env.ROOM.get(env.ROOM.idFromName(room.id))

  // As if the host had first connected `ms` ago.
  const backdate = (room: Room, ms = LIFETIME_MS + 1) =>
    runInDurableObject(stubOf(room), (_: RoomObject, state) => {
      state.storage.kv.put('openedAt', Date.now() - ms)
    })

  const state = (room: Room) =>
    runInDurableObject(stubOf(room), async (_: RoomObject, st) => ({
      opened: st.storage.kv.get<number>('openedAt'),
      admission: st.storage.kv.get('admissionHash'),
      usage: st.storage.kv.get('blobUsage'),
      alarm: await st.storage.getAlarm(),
    }))

  // The room as deployed with other vars.
  const withVars = (room: Room, vars: Record<string, string | undefined>) =>
    runInDurableObject(stubOf(room), (instance: RoomObject) => {
      instance['env'] = { ...instance['env'], ...vars } as Env
    })

  const ranAlarm = (room: Room) => runDurableObjectAlarm(stubOf(room))

  it('starts the clock at the first host connection only, and arms an hourly alarm', async () => {
    const room = await createRoom()
    expect((await state(room)).opened).toBeUndefined()
    const before = Date.now()
    const first = await host(room)
    const s = await state(room)
    expect(s.opened).toBeGreaterThanOrEqual(before)
    expect(s.alarm).toBeGreaterThanOrEqual(before + ALARM_INTERVAL_MS)
    expect(s.alarm).toBeLessThan(Date.now() + ALARM_INTERVAL_MS + 1000)
    await new Promise((r) => setTimeout(r, 20))
    await host(room)
    first.ws.close(HOST_LEFT, 'bye')
    await first.closed
    await host(room)
    expect((await state(room)).opened).toBe(s.opened)
  })

  it('moves the alarm to the deadline once that is sooner than an hour', async () => {
    const room = await createRoom()
    const h = await host(room)
    h.ws.close(HOST_LEFT, 'bye')
    await h.closed
    await backdate(room, LIFETIME_MS - 60_000)
    await host(room)
    const s = await state(room)
    expect(s.alarm).toBeLessThanOrEqual(s.opened! + LIFETIME_MS)
    expect(s.alarm).toBeGreaterThan(Date.now())
    expect(s.alarm).toBeLessThan(Date.now() + 61_000)
  })

  it('ends the room at the deadline with the host still connected', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    expect(await roomBlobs(room)).toHaveLength(1)
    await backdate(room)
    expect(await ranAlarm(room)).toBe(true)
    const [hc, gc] = await Promise.all([h.closed, guest.closed])
    expect([hc.code, gc.code]).toEqual([ROOM_EXPIRED, ROOM_EXPIRED])
    expect(hc.reason).toBe(expiredReason(roomSeconds))
    expect(await roomBlobs(room)).toEqual([])
    const s = await state(room)
    expect(s.opened).toBeDefined()
    expect([s.admission, s.usage, s.alarm]).toEqual([undefined, undefined, null])
  })

  it('never reopens an expired room, for the host or a guest', async () => {
    const room = await createRoom()
    const h = await host(room)
    await backdate(room)
    await ranAlarm(room)
    await h.closed
    const opened = (await state(room)).opened
    const again = await host(room)
    expect((await again.closed).code).toBe(ROOM_EXPIRED)
    const guest = await connect(room.id)
    expect((await guest.closed).code).toBe(ROOM_EXPIRED)
    const s = await state(room)
    expect(s.opened).toBe(opened)
    expect(s.admission).toBeUndefined()
    expect(s.alarm).toBeNull()
  })

  it('refuses a host who comes back after the deadline without an alarm having run', async () => {
    const room = await createRoom()
    const h = await host(room)
    h.ws.close(HOST_LEFT, 'bye')
    await h.closed
    await backdate(room)
    const again = await host(room)
    expect((await again.closed).code).toBe(ROOM_EXPIRED)
    expect((await state(room)).admission).toBeUndefined()
  })

  it('checks again later when the host is still there before the deadline', async () => {
    const room = await createRoom()
    const h = await host(room)
    await backdate(room, 1000)
    expect(await ranAlarm(room)).toBe(true)
    expect(h.ws.readyState).toBe(WebSocket.OPEN)
    const s = await state(room)
    expect(s.alarm).toBeGreaterThan(Date.now())
  })

  it('cleans up a room whose host was cut off without a close, as on a deploy', async () => {
    const room = await createRoom()
    await host(room)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    // The admission and usage stay when the sockets go without webSocketClose.
    await runInDurableObject(stubOf(room), (_: RoomObject, st) => {
      expect(st.storage.kv.get('admissionHash')).toBeDefined()
    })
    await evictDurableObject(stubOf(room), { webSockets: 'close' })
    // Whatever eviction ran, leave a host-less room with everything still in place.
    await runInDurableObject(stubOf(room), (_: RoomObject, st) => {
      st.storage.kv.put('blobUsage', { bytes: 1, count: 1 })
    })
    await env.BLOBS.put(`rooms/${env.ROOM.idFromName(room.id).toString()}/${blobId(2)}`, 'x')
    await ranAlarm(room)
    const s = await state(room)
    expect([s.admission, s.usage]).toEqual([undefined, undefined])
    expect(s.opened).toBeDefined()
    expect(s.alarm).toBeNull()
    expect(await roomBlobs(room)).toEqual([])
    // A guest finds it closed; the next host starts afresh.
    expect((await (await connect(room.id)).closed).code).toBe(ROOM_CLOSED)
    await host(room)
    expect((await putBlob(room, blobId(1), new Uint8Array(90))).status).toBe(201)
  })

  it('leaves a session alone when the alarm runs during a host handshake', async () => {
    const room = await createRoom()
    await host(room)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    await evictDurableObject(stubOf(room), { webSockets: 'close' })
    const alarm = await runInDurableObject(stubOf(room), async (instance: RoomObject, st) => {
      // The host's reconnect has started; the alarm comes while it hashes its token.
      const reconnect = instance.fetch(
        new Request(`https://pedit.test/api/rooms/${room.id}/ws`, {
          headers: {
            Upgrade: 'websocket',
            'Sec-WebSocket-Protocol': legacyProtocols(admissions.get(room.id)!).join(', '),
            'X-Pedit-Host': '1',
          },
        }),
      )
      await instance.alarm()
      const during = {
        admission: st.storage.kv.get('admissionHash') !== undefined,
        alarm: await st.storage.getAlarm(),
      }
      expect((await reconnect).status).toBe(101)
      return during
    })
    expect(alarm.admission).toBe(true)
    expect(alarm.alarm).toBeGreaterThan(Date.now())
    expect(await roomBlobs(room)).toHaveLength(1)
  })

  it('does nothing when the alarm comes after the host left normally', async () => {
    const room = await createRoom()
    const h = await host(room)
    h.ws.close(HOST_LEFT, 'bye')
    await h.closed
    // The room's close handler ends the session; wait until it has.
    await vi.waitFor(async () => expect((await state(room)).admission).toBeUndefined())
    const before = await state(room)
    expect(await ranAlarm(room)).toBe(true)
    const after = await state(room)
    expect(after).toEqual({ ...before, alarm: null })
  })

  it('checks hourly and never ends a room without a limit, but still cleans up', async () => {
    const room = await createRoom()
    const h = await host(room)
    await withVars(room, { ROOM_MAX_SECONDS: undefined })
    // Within the room's life (7 days unless set), which no session limit changes.
    await backdate(room, 3 * 24 * 3600 * 1000)
    expect(await ranAlarm(room)).toBe(true)
    expect(h.ws.readyState).toBe(WebSocket.OPEN)
    const s = await state(room)
    expect(s.alarm).toBeGreaterThan(Date.now() + ALARM_INTERVAL_MS - 5000)
    // A host that is gone still has its session cleaned up.
    h.ws.close(HOST_LEFT, 'bye')
    await h.closed
    await runInDurableObject(stubOf(room), (_: RoomObject, st) => {
      st.storage.kv.put('admissionHash', new Uint8Array(32).buffer)
    })
    await ranAlarm(room)
    expect((await state(room)).admission).toBeUndefined()
  })

  it('drops an upload that is in flight when the room expires', async () => {
    const room = await createRoom()
    const h = await host(room)
    const upload = slowPut(room, blobId(1), 90)
    await upload.started()
    await backdate(room)
    await ranAlarm(room)
    expect((await h.closed).code).toBe(ROOM_EXPIRED)
    expect((await upload.finish()).status).toBe(410)
    expect(await roomBlobs(room)).toEqual([])
  })

  it('ends a room at the next message when its alarm is late', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    await backdate(room)
    guest.ws.send(new Uint8Array(1))
    expect((await guest.closed).code).toBe(ROOM_EXPIRED)
    expect((await h.closed).code).toBe(ROOM_EXPIRED)
    expect(h.received).toHaveLength(0)
  })

  it('serves no blobs of a room past its deadline', async () => {
    const room = await createRoom()
    await host(room)
    await putBlob(room, blobId(1), new Uint8Array([1]))
    await backdate(room)
    expect((await getBlob(room, blobId(1))).status).toBe(410)
    expect((await putBlob(room, blobId(2), new Uint8Array([2]))).status).toBe(410)
  })

  it('reports maintenance at the Worker, but expiry before it inside the room', async () => {
    const room = await createRoom()
    const h = await host(room)
    await backdate(room)
    await withVars(room, { MAINTENANCE: 'closed' })
    h.ws.send(new Uint8Array(1))
    expect((await h.closed).code).toBe(ROOM_EXPIRED)

    const other = await createRoom()
    await host(other)
    await backdate(other)
    const res = await app.fetch(
      new Request(`https://pedit.test/api/rooms/${other.id}/ws`, {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': legacyProtocols(other.admission).join(', '),
        },
      }),
      { ...env, MAINTENANCE: 'closed' },
      createExecutionContext(),
    )
    const ws = res.webSocket as WebSocket
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve))
    ws.accept()
    expect((await closed).code).toBe(RELAY_MAINTENANCE)
  })

  it('cleans up under maintenance too', async () => {
    const room = await createRoom()
    const h = await host(room)
    await withVars(room, { MAINTENANCE: 'closed' })
    await runInDurableObject(stubOf(room), (instance: RoomObject) => {
      for (const ws of instance['ctx'].getWebSockets()) ws.close(1000, 'gone')
    })
    await h.closed
    await runInDurableObject(stubOf(room), (_: RoomObject, st) => {
      st.storage.kv.put('admissionHash', new Uint8Array(32).buffer)
    })
    await ranAlarm(room)
    expect((await state(room)).admission).toBeUndefined()
  })

  it('can run its alarm twice', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    try {
      const room = await createRoom()
      const h = await host(room)
      await backdate(room)
      const run = () => runInDurableObject(stubOf(room), (instance: RoomObject) => instance.alarm())
      await run()
      expect((await h.closed).code).toBe(ROOM_EXPIRED)
      const once = await state(room)
      await run()
      expect(await state(room)).toEqual(once)
      // The host's close and the second alarm clean up again, but the
      // session ended once, when it expired.
      const ended = lines
        .map((l) => JSON.parse(l))
        .filter((e) => e.message === 'room: session ended')
      expect(ended).toEqual([expect.objectContaining({ code: ROOM_EXPIRED })])
    } finally {
      spy.mockRestore()
    }
  })
})

describe('a host that drops', () => {
  const stubOf = (room: Room) => env.ROOM.get(env.ROOM.idFromName(room.id))
  const awayUntil = (room: Room) =>
    runInDurableObject(stubOf(room), (_: RoomObject, st) =>
      st.storage.kv.get<number>('hostAwayUntil'),
    )
  // As if the grace period had run out.
  const endGrace = (room: Room) =>
    runInDurableObject(stubOf(room), (_: RoomObject, st) => {
      st.storage.kv.put('hostAwayUntil', Date.now() - 1)
    })
  const closedEarly = (peer: Peer) =>
    Promise.race([
      peer.closed.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 50)),
    ])

  it('waits when a guest reconnects before the host after a deploy', async () => {
    const room = await createRoom()
    await host(room)
    await connect(room.id)
    const ciphertext = new Uint8Array([7, 8, 9])
    expect((await putBlob(room, blobId(1), ciphertext)).status).toBe(201)
    await evictDurableObject(stubOf(room), { webSockets: 'close' })
    expect(await awayUntil(room)).toBeUndefined()

    const guest = await connect(room.id)
    await until(() => guest.signals.includes('host away'))
    expect(await closedEarly(guest)).toBe(false)
    const grace = await awayUntil(room)
    expect(grace).toBeGreaterThan(Date.now())
    const blob = await getBlob(room, blobId(1))
    expect(blob.status).toBe(200)
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(ciphertext)
    expect((await putBlob(room, blobId(2), ciphertext)).status).toBe(503)
    const late = await connect(room.id)
    await until(() => late.signals.includes('host away'))
    expect(await awayUntil(room)).toBe(grace)

    const back = await host(room)
    await until(() => guest.signals.includes('host back') && late.signals.includes('host back'))
    expect(await awayUntil(room)).toBeUndefined()
    guest.ws.send(ciphertext)
    await until(() => back.received.length === 1)
    expect(back.received).toEqual([ciphertext.buffer])
    back.ws.send(ciphertext)
    await until(() => guest.received.length === 1)
    expect(guest.received).toEqual([ciphertext.buffer])
    expect((await putBlob(room, blobId(2), ciphertext)).status).toBe(201)
  })

  it('does not let a wrong admission start or extend recovery after a deploy', async () => {
    const room = await createRoom()
    await host(room)
    await evictDurableObject(stubOf(room), { webSockets: 'close' })
    const wrong = { 'Sec-WebSocket-Protocol': legacyProtocols('B'.repeat(43)).join(', ') }
    const refused = await connect(room.id, wrong)
    expect((await refused.closed).code).toBe(ROOM_CLOSED)
    expect(await awayUntil(room)).toBeUndefined()

    const guest = await connect(room.id)
    await until(() => guest.signals.includes('host away'))
    const grace = await awayUntil(room)
    expect((await upgrade(room.id, wrong)).status).toBe(403)
    expect(await awayUntil(room)).toBe(grace)
  })

  it('does not let a reader start recovery after a deploy', async () => {
    const room = await createRoom()
    await host(room)
    await evictDurableObject(stubOf(room), { webSockets: 'close' })
    const reader = await connect(room.id, asReader(room))
    expect((await reader.closed).code).toBe(ROOM_CLOSED)
    expect(await awayUntil(room)).toBeUndefined()
    // Once an editor started it, readers come in and wait too.
    const guest = await connect(room.id)
    await until(() => guest.signals.includes('host away'))
    const waiting = await connect(room.id, asReader(room))
    await until(() => waiting.signals.includes('host away'))
  })

  it('does not restart an expired grace period after another deploy', async () => {
    const room = await createRoom()
    await host(room)
    await evictDurableObject(stubOf(room), { webSockets: 'close' })
    const guest = await connect(room.id)
    await until(() => guest.signals.includes('host away'))
    await evictDurableObject(stubOf(room), { webSockets: 'close' })
    await endGrace(room)
    const late = await connect(room.id)
    expect((await late.closed).code).toBe(ROOM_CLOSED)
    expect(await awayUntil(room)).toBeUndefined()
    const again = await connect(room.id)
    expect((await again.closed).code).toBe(ROOM_CLOSED)
    expect(await awayUntil(room)).toBeUndefined()
  })

  it('does not revive an explicitly ended session after a deploy', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    h.ws.close(HOST_LEFT, 'bye')
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
    await evictDurableObject(stubOf(room), { webSockets: 'close' })
    const late = await connect(room.id)
    expect((await late.closed).code).toBe(ROOM_CLOSED)
    expect(await awayUntil(room)).toBeUndefined()
  })

  it('keeps its guests and lets new ones in while it waits, and goes on when it comes back', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    // Any close but HOST_LEFT is a drop.
    h.ws.close(1001, 'gone')
    await until(() => guest.signals.includes('host away'))
    expect(await closedEarly(guest)).toBe(false)
    const before = Date.now()
    expect(await awayUntil(room)).toBeGreaterThanOrEqual(before + 119_000)

    const late = await connect(room.id)
    await until(() => late.signals.includes('host away'))

    const back = await host(room)
    await until(() => guest.signals.includes('host back') && late.signals.includes('host back'))
    expect(back.signals).toEqual([])
    expect(await awayUntil(room)).toBeUndefined()
    guest.ws.send(new Uint8Array([7]))
    await until(() => back.received.length > 0)
  })

  it('closes the room when it does not come back in time', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    h.ws.close(1001, 'gone')
    await until(() => guest.signals.includes('host away'))
    // The alarm waits out the grace period.
    expect(await runDurableObjectAlarm(stubOf(room))).toBe(true)
    expect(await closedEarly(guest)).toBe(false)
    await endGrace(room)
    await runInDurableObject(stubOf(room), (instance: RoomObject) => instance.alarm())
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
    const late = await connect(room.id)
    expect((await late.closed).code).toBe(ROOM_CLOSED)
    expect(await awayUntil(room)).toBeUndefined()
  })

  it('turns a guest away once the grace period ran out, even before its alarm', async () => {
    const room = await createRoom()
    const h = await host(room)
    h.ws.close(1001, 'gone')
    await new Promise((r) => setTimeout(r, 50))
    await endGrace(room)
    const late = await connect(room.id)
    expect((await late.closed).code).toBe(ROOM_CLOSED)
  })

  it('ends the session at once when the host leaves on purpose, though it still counts another', async () => {
    const room = await createRoom()
    // An older connection of the host the relay has not seen close.
    await host(room)
    const h = await host(room)
    const guest = await connect(room.id)
    h.ws.close(HOST_LEFT, 'bye')
    expect((await guest.closed).code).toBe(ROOM_CLOSED)
    expect(guest.signals).toEqual([])
  })

  it('shows attachments while it waits, and takes no new ones', async () => {
    const room = await createRoom()
    const h = await host(room)
    const guest = await connect(room.id)
    expect((await putBlob(room, blobId(1), new Uint8Array(10))).status).toBe(201)
    h.ws.close(1001, 'gone')
    await until(() => guest.signals.includes('host away'))
    expect((await getBlob(room, blobId(1))).status).toBe(200)
    expect((await putBlob(room, blobId(2), new Uint8Array(10))).status).toBe(503)
  })

  it('logs that it waited, and how it ended', async () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    try {
      const room = await createRoom()
      const h = await host(room)
      const guest = await connect(room.id)
      h.ws.close(1001, 'gone')
      await until(() => guest.signals.includes('host away'))
      const back = await host(room)
      await until(() => guest.signals.includes('host back'))
      back.ws.close(1001, 'gone')
      await until(() => guest.signals.filter((m) => m === 'host away').length === 2)
      await endGrace(room)
      await runInDurableObject(stubOf(room), (instance: RoomObject) => instance.alarm())
      await guest.closed
      const messages = lines.map((l) => JSON.parse(l).message)
      expect(
        messages.filter((m: string) => m.startsWith('room: host ') || m === 'room: session ended'),
      ).toEqual([
        'room: host connected',
        'room: host closed',
        'room: host away',
        'room: host connected',
        'room: host returned',
        'room: host closed',
        'room: host away',
        'room: host did not come back',
        'room: session ended',
      ])
    } finally {
      spy.mockRestore()
    }
  })
})
