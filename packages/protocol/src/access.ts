import { fromBase64Url, generateKey, toBase64Url } from './key.ts'

/**
 * What a room link lets its holder do (#122). Each link holds a secret from
 * which the ones below it are derived, one way, so a lower link never yields
 * a higher one:
 *
 * - edit: the edit secret S, the 32 bytes today's link holds. From it, the
 *   editors' Ed25519 signing key and their admission token, and the comment
 *   secret C.
 * - comment: C, which gives the commenters' signing key and the read secret V.
 * - read: V.
 *
 * The frame key K is derived from V, the room id and both verifying keys, so
 * a link carrying a verifying key of someone else's choosing decrypts nothing
 * in the room. A comment link carries the editors' verifying key, and a read
 * link both, since neither can be derived from the secret below it. The
 * reader admission token and the attachment keys come from K. Keep in sync
 * with internal/protocol/access.go; packages/testdata/access-vectors.json pins
 * both.
 */
export type Access = 'edit' | 'comment' | 'read'

const SECRET_BYTES = 32
const PUBLIC_BYTES = 32
const COMMENT_PREFIX = 'c.'
const READ_PREFIX = 'r.'

/** The fragment of a room link: an edit secret, or a marker and the secrets of a lower link. */
export const FRAGMENT_PATTERN = /^(?:[A-Za-z0-9_-]{43}|c\.[A-Za-z0-9_-]{86}|r\.[A-Za-z0-9_-]{128})$/

const LABEL = {
  editSign: 'pedit v5 edit sign',
  editAdmission: 'pedit v5 edit admission',
  comment: 'pedit v5 comment',
  commentSign: 'pedit v5 comment sign',
  read: 'pedit v5 read',
  frame: 'pedit v5 frame',
  readAdmission: 'pedit v5 read admission',
} as const

/** The secrets one link holds, decoded. */
export type LinkSecrets =
  | { access: 'edit'; edit: Uint8Array }
  | { access: 'comment'; comment: Uint8Array; editKey: Uint8Array }
  | { access: 'read'; read: Uint8Array; editKey: Uint8Array; commentKey: Uint8Array }

/** A signing key and the tier its signatures speak for. */
export interface Signer {
  access: 'edit' | 'comment'
  key: CryptoKey
}

/** Everything a client needs from its link, in one room. */
export interface RoomKeys {
  access: Access
  /** AES-GCM key for frames. */
  frameKey: CryptoKey
  /** Verifies editors' and commenters' signatures. */
  editKey: CryptoKey
  commentKey: CryptoKey
  /** Signs this client's frames; none for a read link. */
  signer: Signer | null
  /** Relay capability of everyone in the room; cannot decrypt anything. */
  readAdmission: string
  /** Relay capability of editors only. */
  editAdmission: string | null
  /** The fragments of the links this client can hand out: its own and the ones below it. */
  fragments: Partial<Record<Access, string>>
  /** The frame key's bytes, from which the attachment keys are derived. */
  frameSecret: Uint8Array
}

/** A new edit secret, encoded for a URL fragment. */
export function generateEditSecret(): string {
  return generateKey()
}

/** Reads a link's fragment, without the `#`; null when it is not one. */
export function parseFragment(fragment: string): LinkSecrets | null {
  if (!FRAGMENT_PATTERN.test(fragment)) return null
  if (fragment.startsWith(COMMENT_PREFIX)) {
    const raw = fromBase64Url(fragment.slice(COMMENT_PREFIX.length))
    return { access: 'comment', comment: raw.slice(0, 32), editKey: raw.slice(32) }
  }
  if (fragment.startsWith(READ_PREFIX)) {
    const raw = fromBase64Url(fragment.slice(READ_PREFIX.length))
    return {
      access: 'read',
      read: raw.slice(0, 32),
      editKey: raw.slice(32, 64),
      commentKey: raw.slice(64),
    }
  }
  return { access: 'edit', edit: fromBase64Url(fragment) }
}

// WebCrypto's typings reject views over SharedArrayBuffer; ours never are.
const buf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>
const utf8 = new TextEncoder()

async function hkdf(secret: Uint8Array, info: Uint8Array | string): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle
  const base = await subtle.importKey('raw', buf(secret), 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: typeof info === 'string' ? utf8.encode(info) : buf(info),
    },
    base,
    SECRET_BYTES * 8,
  )
  return new Uint8Array(bits)
}

// PKCS #8 wraps an Ed25519 seed in a fixed prefix (RFC 8410): WebCrypto
// imports private keys only that way or as a JWK, which needs the public key.
const PKCS8_ED25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

/** An Ed25519 key pair from a seed, as Go's ed25519.NewKeyFromSeed makes it. */
async function signingPair(seed: Uint8Array): Promise<{ sign: CryptoKey; publicKey: Uint8Array }> {
  const subtle = globalThis.crypto.subtle
  const pkcs8 = new Uint8Array(PKCS8_ED25519.length + seed.length)
  pkcs8.set(PKCS8_ED25519)
  pkcs8.set(seed, PKCS8_ED25519.length)
  // Extractable only for this export: the JWK of a private key carries its public key.
  const extractable = await subtle.importKey('pkcs8', buf(pkcs8), 'Ed25519', true, ['sign'])
  const jwk = await subtle.exportKey('jwk', extractable)
  if (!jwk.x) throw new Error('no Ed25519 public key')
  const sign = await subtle.importKey('pkcs8', buf(pkcs8), 'Ed25519', false, ['sign'])
  return { sign, publicKey: fromBase64Url(jwk.x) }
}

function verifyingKey(publicKey: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', buf(publicKey), 'Ed25519', false, ['verify'])
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** The raw frame key of a room: what binds V to the room id and both verifying keys. */
export function deriveFrameSecret(
  read: Uint8Array,
  roomId: string,
  editKey: Uint8Array,
  commentKey: Uint8Array,
): Promise<Uint8Array> {
  return hkdf(read, concat(utf8.encode(LABEL.frame), utf8.encode(roomId), editKey, commentKey))
}

/** Derives everything a link gives in the room with this id. */
export async function deriveRoomKeys(link: LinkSecrets, roomId: string): Promise<RoomKeys> {
  checkLink(link)
  let signer: Signer | null = null
  let editAdmission: string | null = null
  let editKey: Uint8Array
  let comment: Uint8Array | null = null
  const fragments: Partial<Record<Access, string>> = {}
  if (link.access === 'edit') {
    const edit = await signingPair(await hkdf(link.edit, LABEL.editSign))
    signer = { access: 'edit', key: edit.sign }
    editKey = edit.publicKey
    editAdmission = toBase64Url(await hkdf(link.edit, LABEL.editAdmission))
    comment = await hkdf(link.edit, LABEL.comment)
    fragments.edit = toBase64Url(link.edit)
  } else {
    editKey = link.editKey
    if (link.access === 'comment') comment = link.comment
  }
  let read: Uint8Array
  let commentKey: Uint8Array
  if (comment) {
    const pair = await signingPair(await hkdf(comment, LABEL.commentSign))
    signer ??= { access: 'comment', key: pair.sign }
    commentKey = pair.publicKey
    read = await hkdf(comment, LABEL.read)
    fragments.comment = COMMENT_PREFIX + toBase64Url(concat(comment, editKey))
  } else {
    // Only a read link has neither S nor C.
    const r = link as Extract<LinkSecrets, { access: 'read' }>
    read = r.read
    commentKey = r.commentKey
  }
  fragments.read = READ_PREFIX + toBase64Url(concat(read, editKey, commentKey))
  const frame = await deriveFrameSecret(read, roomId, editKey, commentKey)
  const subtle = globalThis.crypto.subtle
  const [frameKey, edit, commentVerify] = await Promise.all([
    subtle.importKey('raw', buf(frame), 'AES-GCM', false, ['encrypt', 'decrypt']),
    verifyingKey(editKey),
    verifyingKey(commentKey),
  ])
  return {
    access: link.access,
    frameKey,
    editKey: edit,
    commentKey: commentVerify,
    signer,
    readAdmission: toBase64Url(await hkdf(frame, LABEL.readAdmission)),
    editAdmission,
    fragments,
    frameSecret: frame,
  }
}

function checkLink(link: LinkSecrets): void {
  const sizes: Uint8Array[] =
    link.access === 'edit'
      ? [link.edit]
      : link.access === 'comment'
        ? [link.comment, link.editKey]
        : [link.read, link.editKey, link.commentKey]
  const want = [SECRET_BYTES, PUBLIC_BYTES, PUBLIC_BYTES]
  sizes.forEach((s, i) => {
    if (s.length !== want[i]) throw new Error('invalid link secret')
  })
}
