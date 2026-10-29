import { evictDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { signingPair } from '../../protocol/src/access-crypto.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../protocol/src/kept-access.ts'
import { createKeptSenderCertificate, sealKeptRecord } from '../../protocol/src/kept-record.ts'
import { KeptRoomClient } from '../../protocol/src/kept-room-client.ts'
import fixture from '../../testdata/kept-read-interop.json'
import shared from '../../testdata/kept-recovery-wire.json'

const bytes = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

it('returns signed checkpoint state separately from the provisional tail', async () => {
  const link = parseKeptFragment(fixture.fragment)!
  const keys = await deriveKeptRoomKeys(link, fixture.roomId)
  const epoch = Uint8Array.from(fixture.epoch.match(/../g)!, (x) => parseInt(x, 16))
  const room = env.ROOM.get(env.ROOM.idFromName(fixture.roomId))
  const base = `https://room/internal/kept/${fixture.roomId}`
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
  const sender = await signingPair(new Uint8Array(32).fill(11))
  const cert = await createKeptSenderCertificate(keys, sender.publicKey)
  const record = await sealKeptRecord(
    keys,
    { roomId: fixture.roomId, epoch, generation: 1 },
    sender.sign,
    cert,
    1,
    bytes(shared.textMessage),
  )
  const appended = await room.fetch(`${base}/append`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fixture.editor}`, 'X-Pedit-Epoch': fixture.epoch },
    body: Uint8Array.from(record).buffer,
  })
  expect(appended.status).toBe(200)
  await appended.text()
  let deletes = 0
  const fetcher: typeof fetch = async (input, init) => {
    const response = await room.fetch(new Request(input, init))
    if (init?.method === 'DELETE' && response.status === 204) deletes++
    if (!response.ok) return new Response(await response.text(), { status: response.status })
    return response
  }
  const client = new KeptRoomClient({
    url: 'https://room',
    keys,
    fetch: fetcher,
    attachmentInventory: async () => 'none',
  })
  try {
    const result = await client.inspect()
    expect(result.status).toBe('tail-unverified')
    expect(result.applicable).toBe(false)
    expect(result.checkpoint.kind).toBe('authenticated-checkpoint')
    expect(result.checkpoint.context).toEqual({
      roomId: fixture.roomId,
      epoch,
      generation: 1,
      cutoff: 0,
    })
    expect(result.checkpoint.metadataId).toBe(7)
    expect(result.checkpoint.textState).toEqual(bytes(shared.textState))
    expect(result.checkpoint.commentsState).toEqual(bytes(shared.commentsState))
    expect(result.textState).not.toEqual(result.checkpoint.textState)
    result.checkpoint.context.epoch[0] = result.checkpoint.context.epoch[0]! ^ 255
    result.checkpoint.textState[0] = result.checkpoint.textState[0]! ^ 255
    result.commentsState[0] = result.commentsState[0]! ^ 255
    const next = await client.inspect()
    expect(next.checkpoint.context.epoch).toEqual(epoch)
    expect(next.checkpoint.textState).toEqual(bytes(shared.textState))
    expect(next.checkpoint.commentsState).toEqual(bytes(shared.commentsState))
    for (const field of ['epoch', 'generation', 'cutoff', 'ciphertext'] as const) {
      const forged: typeof fetch = async (input, init) => {
        const response = await fetcher(input, init)
        if (init?.method !== 'POST') return response
        const json = await response.json<{
          epoch: string
          generation: number
          cutoff: number
          ciphertext: string
          tail: number
        }>()
        if (field === 'epoch') json.epoch = '11'.repeat(32)
        else if (field === 'generation') json.generation++
        else if (field === 'cutoff') json.cutoff++
        else {
          const raw = bytes(json.ciphertext)
          raw[raw.length - 1] = raw[raw.length - 1]! ^ 1
          json.ciphertext = btoa(String.fromCharCode(...raw))
        }
        return new Response(JSON.stringify(json), { status: 200 })
      }
      await expect(
        new KeptRoomClient({
          url: 'https://room',
          keys,
          fetch: forged,
          attachmentInventory: async () => 'none',
        }).inspect(),
      ).rejects.toThrow()
    }
    const badTail: typeof fetch = async (input, init) => {
      const response = await fetcher(input, init)
      if (init?.method !== 'GET') return response
      const json = await response.json<{
        entries: { sequence: number; ciphertext: string }[]
        next: string | null
      }>()
      const item = json.entries[0]
      if (!item) throw Error('missing test record')
      const raw = bytes(item.ciphertext)
      raw[raw.length - 1] = raw[raw.length - 1]! ^ 1
      item.ciphertext = btoa(String.fromCharCode(...raw))
      return new Response(JSON.stringify(json), { status: 200 })
    }
    await expect(
      new KeptRoomClient({
        url: 'https://room',
        keys,
        fetch: badTail,
        attachmentInventory: async () => 'none',
      }).inspect(),
    ).rejects.toThrow()
    const wrongKeys = await deriveKeptRoomKeys(link, 'AAECAwQFBgcICQoLDA0ODw')
    await expect(
      new KeptRoomClient({ url: 'https://room', keys: wrongKeys, fetch: fetcher }).inspect(),
    ).rejects.toThrow()
    expect(deletes).toBe(7)
    const malformed: typeof fetch = async (input, init) => {
      const response = await fetcher(input, init)
      if (init?.method !== 'POST') return response
      const value = await response.json<{ epoch: string }>()
      value.epoch = 'not-an-epoch'
      return new Response(JSON.stringify(value), { status: 200 })
    }
    await expect(
      new KeptRoomClient({ url: 'https://room', keys, fetch: malformed }).inspect(),
    ).rejects.toThrow()
    expect(deletes).toBe(8)
    let realSession = ''
    const invalidToken: typeof fetch = async (input, init) => {
      const response = await fetcher(input, init)
      if (init?.method !== 'POST') return response
      const value = await response.json<{ session: string }>()
      realSession = value.session
      value.session = 'not-a-uuid'
      return new Response(JSON.stringify(value), { status: 200 })
    }
    await expect(
      new KeptRoomClient({ url: 'https://room', keys, fetch: invalidToken }).inspect(),
    ).rejects.toThrow()
    expect(deletes).toBe(8)
    const cleanup = await room.fetch(`${base}/read`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${fixture.editor}`, 'X-Pedit-Read-Session': realSession },
    })
    expect(cleanup.status).toBe(204)
    for (const variant of ['whitespace', 'duplicate'] as const) {
      let issued = ''
      const forged: typeof fetch = async (input, init) => {
        const response = await fetcher(input, init)
        if (init?.method !== 'POST') return response
        const raw = await response.text()
        issued = JSON.parse(raw).session
        return new Response(
          variant === 'whitespace' ? ` ${raw}` : `{"session":"${issued}",${raw.slice(1)}`,
          { status: 200 },
        )
      }
      await expect(
        new KeptRoomClient({ url: 'https://room', keys, fetch: forged }).inspect(),
      ).rejects.toThrow()
      expect(deletes).toBe(8)
      const cleanup2 = await room.fetch(`${base}/read`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${fixture.editor}`, 'X-Pedit-Read-Session': issued },
      })
      expect(cleanup2.status).toBe(204)
    }
  } finally {
    await evictDurableObject(room, { webSockets: 'close' })
  }
}, 30000)
