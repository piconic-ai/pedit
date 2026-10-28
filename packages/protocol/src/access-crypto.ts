import { fromBase64Url } from './key.ts'

export const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes)
export const utf8 = new TextEncoder()

export async function hkdf(secret: Uint8Array, info: Uint8Array | string): Promise<Uint8Array> {
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
    32 * 8,
  )
  return new Uint8Array(bits)
}

// PKCS #8 wraps an Ed25519 seed in a fixed prefix (RFC 8410): WebCrypto
// imports private keys only that way or as a JWK, which needs the public key.
const PKCS8_ED25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

/** An Ed25519 key pair from a seed, as Go's ed25519.NewKeyFromSeed makes it. */
export async function signingPair(
  seed: Uint8Array,
): Promise<{ sign: CryptoKey; publicKey: Uint8Array }> {
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

export function verifyingKey(publicKey: Uint8Array): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', buf(publicKey), 'Ed25519', false, ['verify'])
}

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
