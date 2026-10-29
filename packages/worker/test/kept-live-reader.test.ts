import { createExecutionContext, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { signingPair } from '../../protocol/src/access-crypto.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../protocol/src/kept-access.ts'
import { KeptLiveReader } from '../../protocol/src/kept-live-reader.ts'
import { createKeptSenderCertificate, sealKeptRecord } from '../../protocol/src/kept-record.ts'
import { KeptRoomClient } from '../../protocol/src/kept-room-client.ts'
import fixture from '../../testdata/kept-read-interop.json'
import shared from '../../testdata/kept-recovery-wire.json'
import app from '../src/index.ts'
import { KeptTransport } from '../src/kept-transport.ts'

const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const urlBytes = (s: string) => bytes(s.replace(/-/g, '+').replace(/_/g, '/'))

it('catches writes during a fixed read and missed notifications through a later poll', async () => {
  const keys = await deriveKeptRoomKeys(parseKeptFragment(fixture.fragment)!, fixture.roomId)
  const epoch = Uint8Array.from(fixture.epoch.match(/../g)!, (x) => Number.parseInt(x, 16))
  const sender = await signingPair(new Uint8Array(32).fill(11))
  const cert = await createKeptSenderCertificate(keys, sender.publicKey)
  const record = (sequence: number) =>
    sealKeptRecord(
      keys,
      { roomId: fixture.roomId, epoch, generation: 1 },
      sender.sign,
      cert,
      sequence,
      urlBytes(shared.textMessage),
    )
  const first = await record(1),
    second = await record(2)
  const room = env.ROOM.get(env.ROOM.idFromName(fixture.roomId))
  const base = `https://room/internal/kept/${fixture.roomId}`
  const init = await room.fetch(`${base}/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Host ${fixture.hostToken}`,
      'X-Pedit-Editor': fixture.editor,
      'X-Pedit-Commenter': fixture.commenter,
      'X-Pedit-Reader': fixture.reader,
      'X-Pedit-Epoch': fixture.epoch,
      'X-Pedit-Keep-Seconds': '60',
    },
    body: bytes(fixture.checkpoint),
  })
  expect(init.status).toBe(204)
  expect(
    (
      await room.fetch(`${base}/append`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.reader}`,
          'X-Pedit-Epoch': fixture.epoch,
        },
        body: Uint8Array.from(first).buffer,
      })
    ).status,
  ).toBe(403)

  const socketHeaders = (admission: string) => ({
    Upgrade: 'websocket',
    'Sec-WebSocket-Protocol': `pedit-v6, pedit-admission.${admission}`,
  })
  expect(
    (await room.fetch(`${base}/guest`, { headers: socketHeaders(fixture.hostToken) })).status,
  ).toBe(403)
  for (const admission of [fixture.editor, fixture.commenter, fixture.reader]) {
    const connected = await room.fetch(`${base}/guest`, { headers: socketHeaders(admission) })
    expect(connected.status).toBe(101)
    connected.webSocket!.accept()
    connected.webSocket!.close()
  }
  const publicResponse = await app.fetch(
    new Request(`https://room/api/rooms/${fixture.roomId}/guest`, {
      headers: socketHeaders(fixture.reader),
    }),
    env,
    createExecutionContext(),
  )
  expect(publicResponse.status).not.toBe(101)
  const response = await room.fetch(`${base}/guest`, { headers: socketHeaders(fixture.reader) })
  expect(response.status).toBe(101)
  const actual = response.webSocket!
  actual.accept()
  const fake = new EventTarget()
  let notified!: () => void
  const notification = new Promise<void>((resolve) => {
    notified = resolve
  })
  actual.addEventListener('message', (event) => {
    fake.dispatchEvent(new MessageEvent('message', { data: event.data }))
    notified()
  })
  const socket = Object.assign(fake, { close: () => actual.close() }) as unknown as WebSocket
  let injected = false,
    reads = 0
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    const result = await room.fetch(req)
    if (req.method === 'POST') {
      reads++
      if (!injected) {
        injected = true
        const appended = await room.fetch(`${base}/append`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${fixture.editor}`,
            'X-Pedit-Epoch': fixture.epoch,
          },
          body: Uint8Array.from(first).buffer,
        })
        expect(appended.status).toBe(200)
        await notification
      }
    }
    return result
  }
  const results: number[] = []
  let error: Error | undefined
  const options = {
    url: 'https://room',
    keys,
    fetch: fetcher,
    attachmentInventory: async () => 'none' as const,
  }
  let connectedURL = ''
  const live = new KeptLiveReader(
    options,
    (value) => results.push(value.tail),
    (e) => {
      error = e
    },
    (url) => {
      connectedURL = url
      return socket
    },
    1000,
  )
  options.url = 'https://attacker.test'
  live.start()
  expect(connectedURL).toBe(`wss://room/internal/kept/${fixture.roomId}/guest`)
  fake.dispatchEvent(new Event('open'))
  await vi.waitFor(() => expect(results).toContain(1), { timeout: 5000 })
  expect(results).not.toContain(0)
  expect(reads).toBeGreaterThanOrEqual(2)
  await runInDurableObject(room, async (_, state) => {
    await new KeptTransport(
      state,
      env.ROOM,
      { bytes: 10000, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    ).append(fixture.editor, fixture.epoch, Uint8Array.from(second).buffer)
  })
  await vi.waitFor(() => expect(results).toContain(2), { timeout: 5000 })
  expect(error).toBeUndefined()
  fake.dispatchEvent(new Event('close'))
  expect(error?.message).toBe('kept live connection lost')
  const third = await record(3)
  await runInDurableObject(room, async (_, state) => {
    await new KeptTransport(
      state,
      env.ROOM,
      { bytes: 10000, frames: 10 },
      { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
    ).append(fixture.editor, fixture.epoch, Uint8Array.from(third).buffer)
  })
  const again = await room.fetch(`${base}/guest`, { headers: socketHeaders(fixture.reader) })
  expect(again.status).toBe(101)
  const nextSocket = again.webSocket!
  nextSocket.accept()
  const nextEvents = new EventTarget()
  const next = Object.assign(nextEvents, {
    close: () => nextSocket.close(),
  }) as unknown as WebSocket
  const resumed: number[] = []
  const reconnect = new KeptLiveReader(
    { url: 'https://room', keys, fetch: fetcher, attachmentInventory: async () => 'none' },
    (value) => resumed.push(value.tail),
    () => {},
    () => next,
    1000,
  )
  reconnect.start()
  nextEvents.dispatchEvent(new Event('open'))
  await vi.waitFor(() => expect(resumed).toContain(3), { timeout: 5000 })
  reconnect.stop()
  await evictDurableObject(room, { webSockets: 'close' })
}, 20000)

it('uses each link tier for both socket and fixed reads when reader capacity is full', async () => {
  const edit = await deriveKeptRoomKeys(parseKeptFragment(fixture.fragment)!, fixture.roomId)
  const comment = await deriveKeptRoomKeys(
    parseKeptFragment(edit.fragments.comment!)!,
    fixture.roomId,
  )
  const room = env.ROOM.get(env.ROOM.idFromName(fixture.roomId))
  const base = `https://room/internal/kept/${fixture.roomId}`
  await runInDurableObject(room, async (instance) => {
    instance['env'] = { ...instance['env'], ROOM_GUESTS: '3', ROOM_READERS: '1' } as unknown as Env
  })
  expect(
    (
      await room.fetch(`${base}/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Host ${fixture.hostToken}`,
          'X-Pedit-Editor': fixture.editor,
          'X-Pedit-Commenter': fixture.commenter,
          'X-Pedit-Reader': fixture.reader,
          'X-Pedit-Epoch': fixture.epoch,
          'X-Pedit-Keep-Seconds': '60',
        },
        body: bytes(fixture.checkpoint),
      })
    ).status,
  ).toBe(204)
  const low = await room.fetch(`${base}/guest`, {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': `pedit-v6, pedit-admission.${fixture.reader}`,
    },
  })
  expect(low.status).toBe(101)
  low.webSocket!.accept()
  let expectedTail = -1
  const readSessions: string[] = []
  for (let i = 0; i < 40; i++) {
    const response = await room.fetch(`${base}/read`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.reader}`,
      },
    })
    expect(response.status).toBe(200)
    const snapshot = await response.json<{ tail: number; session: string }>()
    expectedTail = snapshot.tail
    readSessions.push(snapshot.session)
  }
  expect(
    (
      await room.fetch(`${base}/read`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fixture.reader}`,
        },
      })
    ).status,
  ).toBe(403)
  const fetcher: typeof fetch = (input, init) => room.fetch(new Request(input, init))
  for (const keys of [comment, edit]) {
    await new KeptRoomClient({
      url: 'https://room',
      keys,
      fetch: fetcher,
      attachmentInventory: async () => 'none',
    }).inspect()
    const eventTarget = new EventTarget()
    let real: WebSocket | undefined
    const proxy = Object.assign(eventTarget, { close: () => real?.close() }) as unknown as WebSocket
    let result: number | undefined, failure: Error | undefined
    const live = new KeptLiveReader(
      { url: 'https://room', keys, fetch: fetcher, attachmentInventory: async () => 'none' },
      (candidate) => {
        result = candidate.tail
      },
      (error) => {
        failure = error
      },
      (_url, protocols) => {
        void room
          .fetch(`${base}/guest`, {
            headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocols.join(', ') },
          })
          .then((response) => {
            if (!response.webSocket) {
              eventTarget.dispatchEvent(new Event('error'))
              return
            }
            real = response.webSocket
            real.accept()
            eventTarget.dispatchEvent(new Event('open'))
          })
        return proxy
      },
      1000,
    )
    live.start()
    await vi.waitFor(
      () => {
        if (failure) throw failure
        expect(result).toBe(expectedTail)
      },
      { timeout: 3000 },
    )
    expect(failure).toBeUndefined()
    live.stop()
  }
  for (const session of readSessions) {
    expect(
      (
        await room.fetch(`${base}/read`, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${fixture.reader}`,
            'X-Pedit-Read-Session': session,
          },
        })
      ).status,
    ).toBe(204)
  }
  low.webSocket!.close()
  await evictDurableObject(room, { webSockets: 'close' })
}, 15000)
