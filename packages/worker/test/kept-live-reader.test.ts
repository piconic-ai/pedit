import { createExecutionContext, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { signingPair } from '../../protocol/src/access-crypto.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../protocol/src/kept-access.ts'
import { KeptLiveReader } from '../../protocol/src/kept-live-reader.ts'
import { createKeptSenderCertificate, sealKeptRecord } from '../../protocol/src/kept-record.ts'
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
})
