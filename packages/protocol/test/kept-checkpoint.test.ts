import { describe, expect, it } from 'vitest'
import access from '../../testdata/kept-access-vectors.json'
import vector from '../../testdata/kept-checkpoint-vectors.json'
import { decrypt, encrypt } from '../src/cipher.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { openKeptCheckpoint } from '../src/kept-checkpoint.ts'
import { fromBase64Url } from '../src/key.ts'

async function reader() {
  const link = parseKeptFragment(access.read)
  if (!link) throw new Error('invalid vector')
  return deriveKeptRoomKeys(link, vector.roomId)
}

const context = () => ({
  roomId: vector.roomId,
  epoch: fromBase64Url(vector.epoch),
  generation: vector.generation,
  cutoff: vector.cutoff,
})

describe('host checkpoints', () => {
  it('opens the shared encrypted vector and rejects wrong context', async () => {
    const keys = await reader()
    const ciphertext = fromBase64Url(vector.ciphertext)
    expect(await openKeptCheckpoint(keys, context(), ciphertext)).toEqual(
      fromBase64Url(vector.payload),
    )
    await expect(
      openKeptCheckpoint(keys, { ...context(), cutoff: 10 }, ciphertext),
    ).rejects.toThrow()
    await expect(
      openKeptCheckpoint(keys, { ...context(), roomId: 'BAECAwQFBgcICQoLDA0ODw' }, ciphertext),
    ).rejects.toThrow()
    await expect(
      openKeptCheckpoint(
        keys,
        { ...context(), generation: Number.MAX_SAFE_INTEGER + 1 },
        ciphertext,
      ),
    ).rejects.toThrow()
    const otherEpoch = context().epoch
    otherEpoch[0] = (otherEpoch[0] ?? 0) ^ 1
    await expect(
      openKeptCheckpoint(keys, { ...context(), epoch: otherEpoch }, ciphertext),
    ).rejects.toThrow()
  })

  it('rejects a ciphertext re-encrypted after a read-link holder changes the payload', async () => {
    const keys = await reader()
    const plain = await decrypt(keys.frameKey, fromBase64Url(vector.ciphertext))
    plain[plain.length - 65] = (plain[plain.length - 65] ?? 0) ^ 1
    const forged = await encrypt(keys.frameKey, plain)
    await expect(openKeptCheckpoint(keys, context(), forged)).rejects.toThrow()
  })

  it('keeps derived keys and frame secrets stable', async () => {
    const keys = await reader()
    expect(Object.isFrozen(keys)).toBe(true)
    expect(Object.isFrozen(keys.fragments)).toBe(true)
    const original = keys.frameSecret.slice()
    keys.frameSecret.fill(0)
    expect(keys.frameSecret).toEqual(original)
    await expect(
      openKeptCheckpoint(keys, context(), fromBase64Url(vector.ciphertext)),
    ).resolves.toBeDefined()
  })

  it('rejects a forged checkpoint even when the supplied key object is replaced', async () => {
    const keys = await reader()
    const plain = await decrypt(keys.frameKey, fromBase64Url(vector.ciphertext))
    plain[plain.length - 65] = (plain[plain.length - 65] ?? 0) ^ 1
    const attacker = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    const end = plain.length - 64
    const signature = await crypto.subtle.sign(
      'Ed25519',
      attacker.privateKey,
      Uint8Array.from(plain.subarray(0, end)),
    )
    plain.set(new Uint8Array(signature), end)
    const forged = await encrypt(keys.frameKey, plain)
    const fake = { ...keys, hostKey: attacker.publicKey }
    await expect(openKeptCheckpoint(fake, context(), forged)).rejects.toThrow()
  })

  it('copies mutable inputs before asynchronous decryption', async () => {
    const keys = await reader()
    const ciphertext = fromBase64Url(vector.ciphertext)
    const expected = context()
    const pending = openKeptCheckpoint(keys, expected, ciphertext)
    ciphertext.fill(0)
    expected.epoch.fill(0)
    expect(await pending).toEqual(fromBase64Url(vector.payload))
  })
})
