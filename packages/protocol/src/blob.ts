import { deriveAdmissionToken } from './admission.ts'
import { decrypt, encrypt } from './cipher.ts'
import { toBase64Url } from './key.ts'

/**
 * Keys for attachments, derived from the frame key (access.ts) with HKDF-SHA256. They are
 * separate from the frame key, so a blob can never be replayed as a frame.
 */
export interface BlobKeys {
  /** Relay capability; cannot decrypt attachments or frames. */
  admission: string
  /** AES-GCM key for blob bodies. */
  enc: CryptoKey
  /** HMAC-SHA256 key for blob ids. */
  id: CryptoKey
}

const ENC_INFO = 'pedit blob enc v2'
const ID_INFO = 'pedit blob id v2'

/** A content hash: the first 128 bits of SHA-256, as 32 lowercase hex digits. */
export const HASH_PATTERN = /^[0-9a-f]{32}$/
/** A blob id: the first 128 bits of an HMAC, as 22 base64url characters. */
export const BLOB_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/

// WebCrypto's typings reject views over SharedArrayBuffer; ours never are.
const buf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>
const utf8 = new TextEncoder()

/**
 * Derives the attachment keys from the frame key's bytes (RoomKeys.frameSecret).
 * `admission` is the token to send the relay, the reader token of the frame
 * key by default; an editor sends its own (RoomKeys.editAdmission), which
 * also lets it add images.
 */
export async function deriveBlobKeys(
  frameSecret: Uint8Array,
  admission?: string,
): Promise<BlobKeys> {
  const subtle = globalThis.crypto.subtle
  const base = await subtle.importKey('raw', buf(frameSecret), 'HKDF', false, ['deriveKey'])
  const hkdf = (info: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(),
    info: utf8.encode(info),
  })
  const [enc, id] = await Promise.all([
    subtle.deriveKey(hkdf(ENC_INFO), base, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
    subtle.deriveKey(hkdf(ID_INFO), base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, [
      'sign',
    ]),
  ])
  return { enc, id, admission: admission ?? (await deriveAdmissionToken(frameSecret)) }
}

/** Names an attachment by its content; the host uses it as the file name. */
export async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf(bytes)))
  let hex = ''
  for (const b of digest.subarray(0, 16)) hex += b.toString(16).padStart(2, '0')
  return hex
}

/**
 * Where the attachment is stored on the server. Anyone in the room can derive it
 * from a link in the document, but the server cannot tell which content it is.
 */
export async function blobIdFor(keys: BlobKeys, hash: string): Promise<string> {
  if (!HASH_PATTERN.test(hash)) throw new Error(`invalid content hash: ${hash}`)
  const mac = await globalThis.crypto.subtle.sign('HMAC', keys.id, utf8.encode(hash))
  return toBase64Url(new Uint8Array(mac).subarray(0, 16))
}

/** Encrypts an attachment as `iv || ciphertext`. */
export function encryptBlob(keys: BlobKeys, plaintext: Uint8Array): Promise<Uint8Array> {
  return encrypt(keys.enc, plaintext)
}

/**
 * Reverses `encryptBlob` and checks the content against the hash it was fetched
 * for: whoever uploaded first under a blob id could have put anything there.
 */
export async function decryptBlob(
  keys: BlobKeys,
  data: Uint8Array,
  hash: string,
): Promise<Uint8Array> {
  const plaintext = await decrypt(keys.enc, data)
  if ((await contentHash(plaintext)) !== hash) throw new Error('attachment does not match its hash')
  return plaintext
}
