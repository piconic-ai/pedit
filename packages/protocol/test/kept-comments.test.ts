import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import v from '../../testdata/kept-comment-vectors.json'
import { deriveRoomKeys, parseFragment, type RoomKeys } from '../src/access.ts'
import {
  acceptedVersion,
  CLIENT_PROTOCOL_VERSIONS,
  offerProtocols,
  PROTOCOL_VERSION,
} from '../src/admission.ts'
import { decrypt, encrypt } from '../src/cipher.ts'
import { type FileEntry, metaPath } from '../src/files.ts'
import {
  decodeCommentUpdate,
  decodeUpdate,
  openKeptFrame,
  openKeptFrameTier,
  sealKeptCommentUpdate,
  sealKeptUpdate,
} from '../src/kept-text.ts'
import { fromBase64Url, toBase64Url } from '../src/key.ts'

const utf8 = new TextEncoder()
const keysOf = (fragment: string): Promise<RoomKeys> => {
  const link = parseFragment(fragment)
  if (!link) throw new Error('fixture link')
  return deriveRoomKeys(link, v.roomId)
}

/** Signs `domain || payload` with `key` and encrypts it, as a holder of that key could. */
async function forge(keys: RoomKeys, key: CryptoKey, domain: string, payload: number[]) {
  const message = new Uint8Array([...utf8.encode(domain), ...payload])
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, message))
  return encrypt(keys.frameKey, new Uint8Array([...message, ...signature]))
}

function commentsUpdate(): Uint8Array {
  const doc = new Y.Doc()
  doc.getMap('comments').set('t1', 'x')
  return Y.encodeStateAsUpdate(doc)
}

describe('shared vector with Go', () => {
  it('seals the pinned message and signature from an edit and a comment link', async () => {
    for (const fragment of [v.edit, v.comment]) {
      const keys = await keysOf(fragment)
      const frame = await sealKeptCommentUpdate(keys, v.fileId, fromBase64Url(v.update))
      const plain = await decrypt(keys.frameKey, frame)
      expect(toBase64Url(plain)).toBe(
        toBase64Url(new Uint8Array([...fromBase64Url(v.message), ...fromBase64Url(v.signature)])),
      )
    }
  })

  it('opens frames built from the pinned bytes, in each tier', async () => {
    const keys = await keysOf(v.read)
    const comment = await openKeptFrameTier(
      keys,
      await encrypt(
        keys.frameKey,
        new Uint8Array([...fromBase64Url(v.message), ...fromBase64Url(v.signature)]),
      ),
    )
    expect(comment.tier).toBe('comment')
    const edit = await openKeptFrameTier(
      keys,
      await encrypt(
        keys.frameKey,
        new Uint8Array([...fromBase64Url(v.editMessage), ...fromBase64Url(v.editSignature)]),
      ),
    )
    expect(edit.tier).toBe('edit')
    expect(decodeUpdate(edit.message)).toEqual({ id: v.fileId, update: fromBase64Url(v.update) })
  })
})

describe('comment-signed kept entries', () => {
  it('round-trips from an edit link and from a comment link, for any link', async () => {
    const update = commentsUpdate()
    for (const fragment of [v.edit, v.comment]) {
      const frame = await sealKeptCommentUpdate(await keysOf(fragment), 7, update)
      for (const reader of [v.edit, v.comment, v.read]) {
        const { tier, message } = await openKeptFrameTier(await keysOf(reader), frame)
        expect(tier).toBe('comment')
        const files: FileEntry[] = [
          { id: 0, path: 'a.md', format: 'text' },
          { id: 7, path: metaPath('a.md'), format: 'meta' },
        ]
        expect(decodeCommentUpdate(message, files)).toEqual({ id: 7, update })
      }
    }
  })

  it('cannot be sealed from a read link', async () => {
    await expect(sealKeptCommentUpdate(await keysOf(v.read), 7, commentsUpdate())).rejects.toThrow()
  })

  it('leaves edit entries as they were, and openKeptFrame refuses comment ones', async () => {
    const keys = await keysOf(v.edit)
    const edit = await sealKeptUpdate(keys, 3, new Uint8Array([9, 9]))
    expect(await openKeptFrameTier(keys, edit)).toMatchObject({ tier: 'edit' })
    expect(decodeUpdate(await openKeptFrame(keys, edit))).toEqual({
      id: 3,
      update: new Uint8Array([9, 9]),
    })
    const comment = await sealKeptCommentUpdate(keys, 3, new Uint8Array([9, 9]))
    await expect(openKeptFrame(keys, comment)).rejects.toThrow('invalid kept signature')
    const { message } = await openKeptFrameTier(keys, comment)
    expect(() => decodeUpdate(message)).toThrow()
  })

  it('never verifies a signature in the other tier’s domain', async () => {
    const keys = await keysOf(v.edit)
    if (!keys.signer || !keys.commentSigner) throw new Error('fixture signers')
    const payload = [0, 0, 0, 1, 1]
    const asComment = await forge(keys, keys.signer.key, 'pedit kept comment update v1\0', payload)
    const asEdit = await forge(keys, keys.commentSigner, 'pedit kept file update v1\0', payload)
    await expect(openKeptFrameTier(keys, asComment)).rejects.toThrow('invalid kept signature')
    await expect(openKeptFrameTier(keys, asEdit)).rejects.toThrow('invalid kept signature')
    await expect(openKeptFrame(keys, asEdit)).rejects.toThrow('invalid kept signature')
  })

  it('accepts only a paired comments doc that passes the comment checks', async () => {
    const files: FileEntry[] = [
      { id: 0, path: 'a.md', format: 'text' },
      { id: 1, path: metaPath('a.md'), format: 'meta' },
      { id: 2, path: 'c.canvas', format: 'canvas' },
      { id: 3, path: metaPath('gone.md'), format: 'meta' },
    ]
    const keys = await keysOf(v.comment)
    const messageFor = async (id: number, update: Uint8Array) =>
      (await openKeptFrameTier(keys, await sealKeptCommentUpdate(keys, id, update))).message
    const ok = commentsUpdate()
    expect(decodeCommentUpdate(await messageFor(1, ok), files)).toEqual({ id: 1, update: ok })
    // The relay's copy of the doc is checked against, when the caller has one.
    expect(decodeCommentUpdate(await messageFor(1, ok), files, new Y.Doc())).toMatchObject({
      id: 1,
    })
    // A text file, a canvas, a meta entry without a file, an unknown id.
    for (const id of [0, 2, 3, 99]) {
      const message = await messageFor(id, ok)
      expect(() => decodeCommentUpdate(message, files)).toThrow()
    }
    const paired = await messageFor(1, ok)
    expect(() => decodeCommentUpdate(paired, undefined)).toThrow()
    const text = new Y.Doc()
    text.getText('content').insert(0, 'x')
    const textMessage = await messageFor(1, Y.encodeStateAsUpdate(text))
    expect(() => decodeCommentUpdate(textMessage, files)).toThrow('invalid kept comments')
  })
})

describe('version negotiation helpers', () => {
  it('offers 8 and 7 newest first, with the admission tokens', () => {
    const token = 'A'.repeat(43)
    const comment = 'B'.repeat(43)
    expect([...CLIENT_PROTOCOL_VERSIONS]).toEqual([8, 7])
    expect(PROTOCOL_VERSION).toBe(7)
    expect(offerProtocols(token)).toEqual(['pedit-v8', 'pedit-v7', `pedit-admission.${token}`])
    expect(offerProtocols(token, comment)).toEqual([
      'pedit-v8',
      'pedit-v7',
      `pedit-admission.${token}`,
      `pedit-comment-admission.${comment}`,
    ])
    expect(() => offerProtocols('bad')).toThrow()
    expect(() => offerProtocols(token, 'bad')).toThrow()
  })

  it('reads the accepted version from the socket protocol', () => {
    expect(acceptedVersion('pedit-v8')).toBe(8)
    expect(acceptedVersion('pedit-v7')).toBe(7)
    for (const bad of [
      '',
      null,
      undefined,
      'pedit-v',
      'pedit-v08',
      'pedit-vx',
      'pedit-admission.x',
    ])
      expect(acceptedVersion(bad)).toBeUndefined()
  })
})
