import { describe, expect, it } from 'vitest'
import access from '../../testdata/kept-access-vectors.json'
import vector from '../../testdata/kept-record-vectors.json'
import { signingPair } from '../src/access-crypto.ts'
import { decrypt, encrypt } from '../src/cipher.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { createKeptSenderCertificate, openKeptRecord, sealKeptRecord } from '../src/kept-record.ts'
import { fromBase64Url } from '../src/key.ts'

async function keysFor(fragment: string) {
  const link = parseKeptFragment(fragment)
  if (!link) throw new Error('invalid vector')
  return deriveKeptRoomKeys(link, vector.roomId)
}
const context = () => ({
  roomId: vector.roomId,
  epoch: fromBase64Url(vector.epoch),
  generation: vector.generation,
})

describe('durable records', () => {
  it('creates and reads an independently generated record', async () => {
    const keys = await keysFor(access.edit)
    const sender = await signingPair(new Uint8Array(32).fill(11))
    const cert = await createKeptSenderCertificate(keys, sender.publicKey)
    expect(cert).toEqual(fromBase64Url(vector.certificate))
    const sealed = await sealKeptRecord(
      keys,
      context(),
      sender.sign,
      cert,
      vector.sequence,
      fromBase64Url(vector.message),
    )
    expect(await decrypt(keys.frameKey, sealed)).toEqual(
      await decrypt(keys.frameKey, fromBase64Url(vector.ciphertext)),
    )
    expect(await openKeptRecord(await keysFor(access.read), context(), sealed)).toEqual({
      access: 'edit',
      sender: sender.publicKey,
      sequence: vector.sequence,
      message: fromBase64Url(vector.message),
    })
  })
  it('rejects forged records and substituted sender or room', async () => {
    const keys = await keysFor(access.edit)
    const cipher = fromBase64Url(vector.ciphertext)
    const plain = await decrypt(keys.frameKey, cipher)
    for (const offset of [0, 23 + 171, 23 + 172, plain.length - 65, plain.length - 1]) {
      const forged = plain.slice()
      forged[offset] = (forged[offset] ?? 0) ^ 1
      await expect(
        openKeptRecord(keys, context(), await encrypt(keys.frameKey, forged)),
      ).rejects.toThrow()
    }
    const other = await signingPair(new Uint8Array(32).fill(12))
    await expect(
      sealKeptRecord(
        keys,
        context(),
        other.sign,
        fromBase64Url(vector.certificate),
        9,
        new Uint8Array([1]),
      ),
    ).rejects.toThrow()
    await expect(openKeptRecord(keys, { ...context(), generation: 2 }, cipher)).rejects.toThrow()
    await expect(openKeptRecord({ ...keys }, context(), cipher)).rejects.toThrow()
    await expect(
      createKeptSenderCertificate(await keysFor(access.read), other.publicKey),
    ).rejects.toThrow()
  })
  it('authenticates comment senders and rejects invalid counters', async () => {
    const keys = await keysFor(access.comment)
    const sender = await signingPair(new Uint8Array(32).fill(13))
    const cert = await createKeptSenderCertificate(keys, sender.publicKey)
    const cipher = await sealKeptRecord(
      keys,
      context(),
      sender.sign,
      cert,
      Number.MAX_SAFE_INTEGER,
      new Uint8Array([7]),
    )
    const record = await openKeptRecord(await keysFor(access.read), context(), cipher)
    expect(record.access).toBe('comment')
    expect(record.sequence).toBe(Number.MAX_SAFE_INTEGER)
    for (const sequence of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(
        sealKeptRecord(keys, context(), sender.sign, cert, sequence, new Uint8Array([7])),
      ).rejects.toThrow()
    }
  })

  it('snapshots mutable inputs before awaiting', async () => {
    const keys = await keysFor(access.edit)
    const sender = await signingPair(new Uint8Array(32).fill(11))
    const cert = fromBase64Url(vector.certificate)
    const message = fromBase64Url(vector.message)
    const c = context()
    const pending = sealKeptRecord(keys, c, sender.sign, cert, 9, message)
    cert.fill(0)
    message.fill(0)
    c.epoch.fill(0)
    expect((await openKeptRecord(keys, context(), await pending)).message).toEqual(
      fromBase64Url(vector.message),
    )
  })
})
