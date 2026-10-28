import { ed25519 } from '@noble/curves/ed25519.js'
import type { Access, RoomKeys } from './access.ts'
import { buf, concat, hkdf, signingPair, utf8, verifyingKey } from './access-crypto.ts'
import { deriveAdmissionToken } from './admission.ts'
import { fromBase64Url, toBase64Url } from './key.ts'

export type KeptLinkSecrets =
  | { access: 'edit'; secret: Uint8Array; hostKey: Uint8Array }
  | { access: 'comment'; secret: Uint8Array; editKey: Uint8Array; hostKey: Uint8Array }
  | {
      access: 'read'
      secret: Uint8Array
      editKey: Uint8Array
      commentKey: Uint8Array
      hostKey: Uint8Array
    }

export interface KeptSigner {
  version: 'v6'
  access: 'edit' | 'comment'
  key: CryptoKey
}

const keptKeysBrand: unique symbol = Symbol('kept room keys')
const derivedKeys = new WeakSet<object>()

export interface KeptRoomKeys extends Readonly<Omit<RoomKeys, 'version' | 'signer'>> {
  readonly [keptKeysBrand]: true
  version: 'v6'
  roomId: string
  signer: KeptSigner | null
  hostKey: CryptoKey
  commentAdmission: string | null
}

export function parseKeptFragment(fragment: string): KeptLinkSecrets | null {
  const match = /^v6\.([ecr])\.([A-Za-z0-9_-]+)$/.exec(fragment)
  if (!match || match[0] !== fragment) return null
  try {
    const length = match[1] === 'e' ? 86 : match[1] === 'c' ? 128 : 171
    if (match[2]?.length !== length) return null
    const raw = fromBase64Url(match[2] ?? '')
    if (toBase64Url(raw) !== match[2]) return null
    if (!validKeptPublicKey(raw.slice(-32))) return null
    if (match[1] !== 'e' && !validKeptPublicKey(raw.slice(32, 64))) return null
    if (match[1] === 'r' && !validKeptPublicKey(raw.slice(64, 96))) return null
    switch (match[1]) {
      case 'e':
        return { access: 'edit', secret: raw.slice(0, 32), hostKey: raw.slice(32) }
      case 'c':
        return {
          access: 'comment',
          secret: raw.slice(0, 32),
          editKey: raw.slice(32, 64),
          hostKey: raw.slice(64),
        }
      case 'r':
        return {
          access: 'read',
          secret: raw.slice(0, 32),
          editKey: raw.slice(32, 64),
          commentKey: raw.slice(64, 96),
          hostKey: raw.slice(96),
        }
      default:
        return null
    }
  } catch {
    return null
  }
}

export async function deriveKeptRoomKeys(
  link: KeptLinkSecrets,
  roomId: string,
): Promise<KeptRoomKeys> {
  switch (link.access) {
    case 'edit':
      link = {
        access: 'edit',
        secret: Uint8Array.from(link.secret),
        hostKey: Uint8Array.from(link.hostKey),
      }
      break
    case 'comment':
      link = {
        access: 'comment',
        secret: Uint8Array.from(link.secret),
        editKey: Uint8Array.from(link.editKey),
        hostKey: Uint8Array.from(link.hostKey),
      }
      break
    case 'read':
      link = {
        access: 'read',
        secret: Uint8Array.from(link.secret),
        editKey: Uint8Array.from(link.editKey),
        commentKey: Uint8Array.from(link.commentKey),
        hostKey: Uint8Array.from(link.hostKey),
      }
      break
  }
  const keys = [link.secret, link.hostKey]
  if (link.access !== 'edit') keys.push(link.editKey)
  if (link.access === 'read') keys.push(link.commentKey)
  if (
    keys.some((key) => key.length !== 32) ||
    !validKeptPublicKey(link.hostKey) ||
    (link.access !== 'edit' && !validKeptPublicKey(link.editKey)) ||
    (link.access === 'read' && !validKeptPublicKey(link.commentKey))
  ) {
    throw new Error('invalid kept room link')
  }
  if (roomId.length !== 22 || !/^[A-Za-z0-9_-]{22}$/.test(roomId))
    throw new Error('invalid room ID')
  const room = utf8.encode(roomId)
  const length = new Uint8Array(2)
  new DataView(length.buffer).setUint16(0, room.length)
  let signer: KeptSigner | null = null
  let editAdmission: string | null = null
  let editKey: Uint8Array
  let comment: Uint8Array | null = null
  const fragments: Partial<Record<Access, string>> = {}
  if (link.access === 'edit') {
    const edit = await signingPair(await hkdf(link.secret, 'pedit v6 edit sign'))
    signer = { version: 'v6', access: 'edit', key: edit.sign }
    editKey = edit.publicKey
    editAdmission = toBase64Url(await hkdf(link.secret, 'pedit v6 edit admission'))
    comment = await hkdf(link.secret, 'pedit v6 comment')
    fragments.edit = `v6.e.${toBase64Url(concat(link.secret, link.hostKey))}`
  } else {
    editKey = link.editKey
    if (link.access === 'comment') comment = link.secret
  }
  let read: Uint8Array
  let commentKey: Uint8Array
  if (comment) {
    const pair = await signingPair(await hkdf(comment, 'pedit v6 comment sign'))
    signer ??= { version: 'v6', access: 'comment', key: pair.sign }
    commentKey = pair.publicKey
    read = await hkdf(comment, 'pedit v6 read')
    fragments.comment = `v6.c.${toBase64Url(concat(comment, editKey, link.hostKey))}`
  } else {
    if (link.access !== 'read') throw new Error('invalid kept room link')
    read = link.secret
    commentKey = link.commentKey
  }
  fragments.read = `v6.r.${toBase64Url(concat(read, editKey, commentKey, link.hostKey))}`
  const frame = await hkdf(
    read,
    concat(utf8.encode('pedit v6 frame'), length, room, editKey, commentKey, link.hostKey),
  )
  const commentAdmission = comment
    ? toBase64Url(
        await hkdf(
          comment,
          concat(
            utf8.encode('pedit v6 comment admission'),
            length,
            room,
            editKey,
            commentKey,
            link.hostKey,
          ),
        ),
      )
    : null
  const subtle = globalThis.crypto.subtle
  const [frameKey, edit, commentVerify, hostKey] = await Promise.all([
    subtle.importKey('raw', buf(frame), 'AES-GCM', false, ['encrypt', 'decrypt']),
    verifyingKey(editKey),
    verifyingKey(commentKey),
    verifyingKey(link.hostKey),
  ])
  if (signer) Object.freeze(signer)
  Object.freeze(fragments)
  const result: KeptRoomKeys = {
    [keptKeysBrand]: true,
    version: 'v6',
    roomId,
    access: link.access,
    frameKey,
    editKey: edit,
    commentKey: commentVerify,
    hostKey,
    signer,
    readAdmission: await deriveAdmissionToken(frame),
    editAdmission,
    commentAdmission,
    fragments,
    get frameSecret() {
      return Uint8Array.from(frame)
    },
  }
  Object.freeze(result)
  derivedKeys.add(result)
  return result
}

export function isKeptRoomKeys(keys: KeptRoomKeys): boolean {
  return derivedKeys.has(keys)
}

function validKeptPublicKey(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false
  try {
    const point = ed25519.Point.fromBytes(raw, false)
    return !point.is0() && point.isTorsionFree() && point.toBytes().every((b, i) => b === raw[i])
  } catch {
    return false
  }
}
