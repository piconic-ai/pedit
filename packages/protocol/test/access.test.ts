import { describe, expect, it } from 'vitest'
// Written by the Go side (internal/protocol/access_test.go), so both derive the same.
import v from '../../testdata/access-vectors.json'
import {
  type Access,
  deriveFrameSecret,
  deriveRoomKeys,
  FRAGMENT_PATTERN,
  generateEditSecret,
  type LinkSecrets,
  parseFragment,
} from '../src/access.ts'
import { decrypt, encrypt } from '../src/cipher.ts'
import { fromBase64Url, toBase64Url } from '../src/key.ts'

const keys = async (fragment: string, roomId = v.roomId) => {
  const link = parseFragment(fragment)
  if (!link) throw new Error(`not a link: ${fragment}`)
  return deriveRoomKeys(link, roomId)
}

const bytes = (s: string) => new TextEncoder().encode(s)

describe('room links', () => {
  it('derive the same room as the Go implementation, from every link', async () => {
    const all = { edit: v.edit, comment: v.comment, read: v.read }
    const below: Record<Access, Access[]> = {
      edit: ['edit', 'comment', 'read'],
      comment: ['comment', 'read'],
      read: ['read'],
    }
    const frame = await deriveFrameSecret(
      fromBase64Url(v.read.slice(2)).slice(0, 32),
      v.roomId,
      fromBase64Url(v.editKey),
      fromBase64Url(v.commentKey),
    )
    expect(toBase64Url(frame)).toBe(v.frameKey)
    for (const access of ['edit', 'comment', 'read'] as const) {
      const k = await keys(all[access])
      expect(k.access).toBe(access)
      expect(toBase64Url(k.frameSecret)).toBe(v.frameKey)
      expect(k.readAdmission).toBe(v.readAdmission)
      expect(k.editAdmission).toBe(access === 'edit' ? v.editAdmission : null)
      expect(k.fragments).toEqual(Object.fromEntries(below[access].map((a) => [a, all[a]])))
      // Frames one link encrypts, every other link decrypts.
      const sealed = await encrypt(k.frameKey, bytes(access))
      const other = await keys(all[access === 'read' ? 'edit' : 'read'])
      expect(await decrypt(other.frameKey, sealed)).toEqual(bytes(access))
    }
  })

  it('sign as the tier of the link, and verify both tiers', async () => {
    const data = bytes('frame')
    const subtle = globalThis.crypto.subtle
    const edit = await keys(v.edit)
    const comment = await keys(v.comment)
    expect((await keys(v.read)).signer).toBeNull()
    expect(edit.signer?.access).toBe('edit')
    expect(comment.signer?.access).toBe('comment')
    for (const k of [edit, comment]) {
      if (!k.signer) throw new Error('no signer')
      const sig = await subtle.sign('Ed25519', k.signer.key, data)
      const right = k.signer.access === 'edit' ? k.editKey : k.commentKey
      const wrong = k.signer.access === 'edit' ? k.commentKey : k.editKey
      expect(await subtle.verify('Ed25519', right, sig, data)).toBe(true)
      expect(await subtle.verify('Ed25519', wrong, sig, data)).toBe(false)
    }
  })

  it('give another frame key for a substituted verifying key or another room', async () => {
    const read = parseFragment(v.read) as Extract<LinkSecrets, { access: 'read' }>
    const comment = parseFragment(v.comment) as Extract<LinkSecrets, { access: 'comment' }>
    const other = new Uint8Array(32).fill(7)
    for (const [link, room] of [
      [{ ...read, editKey: other }, v.roomId],
      [{ ...read, commentKey: other }, v.roomId],
      [{ ...comment, editKey: other }, v.roomId],
      [read, 'AQECAwQFBgcICQoLDA0ODw'],
    ] as const) {
      const k = await deriveRoomKeys(link, room)
      expect(toBase64Url(k.frameSecret)).not.toBe(v.frameKey)
      expect(k.readAdmission).not.toBe(v.readAdmission)
    }
  })

  it('share no value with version 1', () => {
    for (const value of [
      v.comment,
      v.read,
      v.editKey,
      v.commentKey,
      v.frameKey,
      v.editAdmission,
      v.readAdmission,
    ]) {
      expect(value).not.toContain(v.v1Admission)
      expect(value).not.toContain(v.edit)
    }
  })

  it('refuse text that is not a link', async () => {
    for (const f of [
      '',
      v.edit.slice(1),
      `${v.edit}A`,
      `c.${v.edit}`,
      v.comment.slice(0, -1),
      `x.${v.comment.slice(2)}`,
      `r.${v.comment.slice(2)}`,
      `${v.read}A`,
      `+${v.edit.slice(1)}`,
    ]) {
      expect(parseFragment(f)).toBeNull()
    }
    expect(FRAGMENT_PATTERN.test(generateEditSecret())).toBe(true)
    await expect(
      deriveRoomKeys(
        { access: 'comment', comment: new Uint8Array(3), editKey: new Uint8Array(32) },
        v.roomId,
      ),
    ).rejects.toThrow()
  })
})
