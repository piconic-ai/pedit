import { evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { concat, signingPair } from '../../protocol/src/access-crypto.ts'
import { decrypt, encrypt } from '../../protocol/src/cipher.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../protocol/src/kept-access.ts'
import { KeptLedger, type KeptReceipt } from '../../protocol/src/kept-ledger.ts'
import { createKeptSenderCertificate, sealKeptRecord } from '../../protocol/src/kept-record.ts'
import { KeptRoomClient } from '../../protocol/src/kept-room-client.ts'
import {
  decodeKeptTextPayload,
  encodeKeptTextPayload,
} from '../../protocol/src/kept-text-payload.ts'
import { largeKeptTextMessage } from '../../protocol/test/kept-large-update.ts'
import fixture from '../../testdata/kept-read-interop.json'
import shared from '../../testdata/kept-recovery-wire.json'
import { KeptTransport } from '../src/kept-transport.ts'
import { roomIdFor } from '../src/room-identity.ts'

const bytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

it.each([
  { baseline: 1024, tail: 1, accepted: true },
  { baseline: 1025, tail: 1, accepted: true },
  { baseline: 10000, tail: 1, accepted: true },
  { baseline: 10001, tail: 1, accepted: false },
  { baseline: 0, tail: 1024, accepted: true },
  { baseline: 0, tail: 1025, accepted: false },
  { baseline: 0, tail: 19, accepted: false, large: true },
])(
  'bounds checkpoint receipts and tail independently: $baseline + $tail',
  async ({ baseline, tail, accepted, large }) => {
    const link = parseKeptFragment(fixture.fragment)!
    const hostToken = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const roomId = await roomIdFor(hostToken)
    const originalKeys = await deriveKeptRoomKeys(link, fixture.roomId)
    const keys = await deriveKeptRoomKeys(link, roomId)
    const epoch = Uint8Array.from(fixture.epoch.match(/../g)!, (x) => parseInt(x, 16))
    const original = bytes(fixture.checkpoint)
    const decoded = await decrypt(originalKeys.frameKey, original)
    const headerLength = 'pedit/v6/checkpoint\0'.length + 22 + 32 + 8 + 8 + 4
    const payload = decodeKeptTextPayload(
      decoded.subarray(headerLength, decoded.length - 64),
      10000,
    )
    const receipts: KeptReceipt[] = Array.from({ length: baseline }, (_, i) => ({
      access: 'edit',
      sender: '00'.repeat(32),
      sequence: i + 1,
      digest: '01'.repeat(32),
      outcome: 'applied',
    }))
    const ledger = KeptLedger.restore(baseline + 1, receipts)
    const body = encodeKeptTextPayload({ ...payload, ledger })
    const header = decoded.slice(0, headerLength)
    header.set(new TextEncoder().encode(roomId), 'pedit/v6/checkpoint\0'.length)
    new DataView(header.buffer, header.byteOffset, header.byteLength).setUint32(
      headerLength - 4,
      body.length,
    )
    const signed = concat(header, body)
    const host = await signingPair(new Uint8Array(32).fill(7))
    const signature = new Uint8Array(
      await crypto.subtle.sign('Ed25519', host.sign, Uint8Array.from(signed).buffer),
    )
    const checkpoint = await encrypt(keys.frameKey, concat(signed, signature))
    const room = env.ROOM.get(env.ROOM.idFromName(roomId))
    const sender = await signingPair(new Uint8Array(32).fill(11))
    const certificate = await createKeptSenderCertificate(keys, sender.publicKey)
    const context = { roomId, epoch, generation: 1 }
    let message: Uint8Array = bytes(shared.textMessage)
    if (large) message = largeKeptTextMessage(900_000)

    await runInDurableObject(room, async (_, state) => {
      const transport = new KeptTransport(
        state,
        env.ROOM,
        { bytes: 50 * 1024 * 1024, frames: 1100 },
        { requestedSeconds: 60, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 60 },
      )
      await transport.initialize(
        roomId,
        hostToken,
        {
          editor: keys.editAdmission!,
          commenter: keys.commentAdmission!,
          reader: keys.readAdmission,
        },
        fixture.epoch,
        Uint8Array.from(checkpoint).buffer,
      )
      for (let i = 1; i <= tail; i++) {
        const record = await sealKeptRecord(keys, context, sender.sign, certificate, i, message)
        await transport.append(keys.editAdmission!, fixture.epoch, Uint8Array.from(record).buffer)
      }
    })
    const client = new KeptRoomClient({
      url: 'https://room',
      keys,
      fetch: (input, init) => room.fetch(new Request(input, init)),
      attachmentInventory: async () => 'none',
    })
    try {
      if (accepted) {
        const result = await client.inspect()
        expect(result.records).toBe(tail)
        expect(result.status).toBe('tail-unverified')
      } else if (baseline > 10000)
        await expect(client.inspect()).rejects.toThrow('invalid ledger encoding')
      else await expect(client.inspect()).rejects.toThrow('kept read capacity reached')
      expect(ledger.snapshot()).toEqual(receipts)
      const current = await room.fetch(`https://room/internal/kept/${roomId}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${keys.readAdmission}` },
      })
      const snapshot = await current.json<{ ciphertext: string; session: string }>()
      expect(bytes(snapshot.ciphertext)).toEqual(checkpoint)
      await room.fetch(`https://room/internal/kept/${roomId}/read`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${keys.readAdmission}`,
          'X-Pedit-Read-Session': snapshot.session,
        },
      })
    } finally {
      await evictDurableObject(room, { webSockets: 'close' })
    }
  },
  30000,
)
