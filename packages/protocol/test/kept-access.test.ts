import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import vector from '../../testdata/kept-access-vectors.json'
import { parseFragment, type RoomKeys, type Signer } from '../src/access.ts'
import {
  deriveKeptRoomKeys,
  type KeptRoomKeys,
  type KeptSigner,
  parseKeptFragment,
} from '../src/kept-access.ts'
import { fromBase64Url, toBase64Url } from '../src/key.ts'
import { RoomClient } from '../src/room.ts'
import { openMessage, signMessage } from '../src/signed.ts'

type AssertFalse<T extends false> = T
type KeysAreNotV5 = AssertFalse<KeptRoomKeys extends RoomKeys ? true : false>
type SignerIsNotV5 = AssertFalse<KeptSigner extends Signer ? true : false>
type VerifyKeysAreNotV5 = AssertFalse<
  KeptRoomKeys extends Parameters<typeof openMessage>[0] ? true : false
>

describe('kept room links', () => {
  it('keeps v6 keys and signers out of the v5 types', () => {
    const checks: [KeysAreNotV5, SignerIsNotV5, VerifyKeysAreNotV5] = [false, false, false]
    expect(checks).toEqual([false, false, false])
  })

  it('rejects v6 keys in v5 runtime APIs', async () => {
    const link = parseKeptFragment(vector.edit)
    if (!link) throw new Error('invalid vector')
    const keys = await deriveKeptRoomKeys(link, vector.roomId)
    if (!keys.signer) throw new Error('missing signer')
    await expect(
      Reflect.apply(signMessage, null, [keys.signer, new Uint8Array(), new Uint8Array()]),
    ).rejects.toThrow('wrong signing protocol')
    await expect(
      Reflect.apply(openMessage, null, [keys, new Uint8Array(), new Uint8Array()]),
    ).rejects.toThrow('wrong signing protocol')
    expect(() => Reflect.construct(RoomClient, [{ keys }])).toThrow('wrong room protocol')
  })
  it('matches the shared cross-language vector', async () => {
    const link = parseKeptFragment(vector.edit)
    if (!link) throw new Error('invalid vector')
    const keys = await deriveKeptRoomKeys(link, vector.roomId)
    expect(keys.fragments).toEqual({
      edit: vector.edit,
      comment: vector.comment,
      read: vector.read,
    })
    expect(toBase64Url(keys.frameSecret)).toBe(vector.frameKey)
    expect(keys.editAdmission).toBe(vector.editAdmission)
    expect(keys.readAdmission).toBe(vector.readAdmission)
    expect(toBase64Url(link.hostKey)).toBe(vector.hostKey)
    expect(parseFragment(vector.edit)).toBeNull()
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        keys.hostKey,
        Uint8Array.from(fromBase64Url(vector.hostSignature)),
        new TextEncoder().encode('kept checkpoint vector'),
      ),
    ).toBe(true)
    expect(
      await crypto.subtle.verify(
        'Ed25519',
        keys.hostKey,
        Uint8Array.from(fromBase64Url(vector.hostSignature)),
        new TextEncoder().encode('another message'),
      ),
    ).toBe(false)
  })

  it('uses the validated link even if the caller mutates its arrays while deriving', async () => {
    const link = parseKeptFragment(vector.edit)
    if (!link) throw new Error('invalid vector')
    const deriving = deriveKeptRoomKeys(link, vector.roomId)
    link.secret.fill(0)
    link.hostKey.fill(0)
    const keys = await deriving
    expect(keys.fragments.edit).toBe(vector.edit)
    expect(toBase64Url(keys.frameSecret)).toBe(vector.frameKey)
  })

  it('copies Buffer inputs before asynchronous derivation', async () => {
    const link = parseKeptFragment(vector.edit)
    if (!link || link.access !== 'edit') throw new Error('invalid vector')
    const secret = Buffer.from(link.secret)
    const hostKey = Buffer.from(link.hostKey)
    const deriving = deriveKeptRoomKeys({ access: 'edit', secret, hostKey }, vector.roomId)
    secret.fill(0)
    hostKey.fill(0)
    const keys = await deriving
    expect(keys.fragments.edit).toBe(vector.edit)
    expect(toBase64Url(keys.frameSecret)).toBe(vector.frameKey)
  })

  it('copies all read-link keys before asynchronous derivation', async () => {
    const link = parseKeptFragment(vector.read)
    if (!link || link.access !== 'read') throw new Error('invalid vector')
    const read = {
      ...link,
      secret: Buffer.from(link.secret),
      editKey: Buffer.from(link.editKey),
      commentKey: Buffer.from(link.commentKey),
      hostKey: Buffer.from(link.hostKey),
    }
    const deriving = deriveKeptRoomKeys(read, vector.roomId)
    read.secret.fill(0)
    read.editKey.fill(0)
    read.commentKey.fill(0)
    read.hostKey.fill(0)
    expect(toBase64Url((await deriving).frameSecret)).toBe(vector.frameKey)
  })
  it('derives the same room keys for every access tier and binds the host', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    const host = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const link = { access: 'edit' as const, secret: new Uint8Array(32).fill(3), hostKey: host }
    const editor = await deriveKeptRoomKeys(link, vector.roomId)
    for (const access of ['edit', 'comment', 'read'] as const) {
      const fragment = editor.fragments[access]
      expect(fragment).toBeDefined()
      const parsed = parseKeptFragment(fragment ?? '')
      expect(parsed?.access).toBe(access)
      if (!parsed) throw new Error('invalid fragment')
      const keys = await deriveKeptRoomKeys(parsed, vector.roomId)
      expect(keys.frameSecret).toEqual(editor.frameSecret)
      if (access !== 'edit') expect(keys.fragments.edit).toBeUndefined()
      if (access === 'read') expect(keys.fragments.comment).toBeUndefined()
    }
    if (!editor.signer) throw new Error('missing editor signer')
    const signature = await crypto.subtle.sign('Ed25519', editor.signer.key, new Uint8Array([1]))
    expect(
      await crypto.subtle.verify('Ed25519', pair.publicKey, signature, new Uint8Array([1])),
    ).toBe(false)
    const otherHost = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
    const changed = new Uint8Array(await crypto.subtle.exportKey('raw', otherHost.publicKey))
    expect(
      (await deriveKeptRoomKeys({ ...link, hostKey: changed }, vector.roomId)).frameSecret,
    ).not.toEqual(editor.frameSecret)
    expect((await deriveKeptRoomKeys(link, 'BAECAwQFBgcICQoLDA0ODw')).frameSecret).not.toEqual(
      editor.frameSecret,
    )
    for (const invalid of ['', 'room-one', '室', `${vector.roomId}\n`]) {
      await expect(deriveKeptRoomKeys(link, invalid)).rejects.toThrow('invalid room ID')
    }
  })

  it('rejects malformed and non-canonical fragments', () => {
    for (const fragment of [
      '',
      'v6.e.A',
      'v5.e.invalid',
      `v6.e.${'A'.repeat(86)}`,
      `v6.r.${'A'.repeat(170)}B`,
      `${vector.edit}\n`,
    ]) {
      expect(parseKeptFragment(fragment)).toBeNull()
    }
  })

  it('rejects fragments with missing or extra encoded bytes at every tier', () => {
    for (const fragment of [vector.edit, vector.comment, vector.read]) {
      expect(parseKeptFragment(fragment.slice(0, -1))).toBeNull()
      expect(parseKeptFragment(`${fragment}A`)).toBeNull()
    }
  })

  it('rejects non-canonical and non-prime-order public keys at every tier', async () => {
    for (const invalidKey of vector.invalidPublicKeys) {
      for (const offset of [32, 64, 96]) {
        const raw = fromBase64Url(vector.read.slice(5))
        raw.set(fromBase64Url(invalidKey.key), offset)
        expect(parseKeptFragment(`v6.r.${toBase64Url(raw)}`)).toBeNull()
        const link = parseKeptFragment(vector.read)
        if (!link || link.access !== 'read') throw new Error('invalid vector')
        const invalid = fromBase64Url(invalidKey.key)
        if (offset === 32) link.editKey.set(invalid)
        if (offset === 64) link.commentKey.set(invalid)
        if (offset === 96) link.hostKey.set(invalid)
        await expect(deriveKeptRoomKeys(link, vector.roomId)).rejects.toThrow(
          'invalid kept room link',
        )
      }
    }
  })
})
