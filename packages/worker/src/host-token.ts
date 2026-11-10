/**
 * Host tokens authenticate issuance by the relay without storing reservations.
 * pe2_ is followed by base64url(time[6] || nonce[16] || HMAC-SHA256[16]).
 * The MAC covers the prefix and payload. Clients treat the 55 characters as opaque.
 */
const HOST_TOKEN_PREFIX = 'pe2_'
const TIME_BYTES = 6
const RANDOM_BYTES = 16
const TAG_BYTES = 16
const PAYLOAD_BYTES = TIME_BYTES + RANDOM_BYTES

/** How long after its issue a host token may still open a room. */
export const OPEN_WINDOW_MS = 24 * 60 * 60 * 1000

/** How far ahead of the room's clock an issue time may be. */
export const ISSUE_SKEW_MS = 5 * 60 * 1000

export interface HostTokenSecrets {
  HOST_TOKEN_SECRET?: string
  HOST_TOKEN_PREVIOUS_SECRET?: string
}

export type VerifiedHostToken = { kind: 'signed'; issued: number } | { kind: 'legacy' }

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
    return base64url(bytes) === text ? bytes : undefined
  } catch {
    return undefined
  }
}

function secretBytes(secret: string | undefined): Uint8Array<ArrayBuffer> | undefined {
  if (secret === undefined) return undefined
  const bytes = fromBase64url(secret)
  return bytes?.length === 32 ? bytes : undefined
}

/** A missing or malformed current key must never fall back to unsigned issuance. */
export function hostTokenConfigured(secrets: HostTokenSecrets): boolean {
  return (
    secretBytes(secrets.HOST_TOKEN_SECRET) !== undefined &&
    (secrets.HOST_TOKEN_PREVIOUS_SECRET === undefined ||
      secretBytes(secrets.HOST_TOKEN_PREVIOUS_SECRET) !== undefined)
  )
}

async function tag(secret: string, payload: Uint8Array): Promise<ArrayBuffer> {
  const bytes = secretBytes(secret)
  if (!bytes) throw new Error('Invalid host token signing configuration')
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const message = new TextEncoder().encode(HOST_TOKEN_PREFIX + base64url(payload))
  return (await crypto.subtle.sign('HMAC', key, message)).slice(0, TAG_BYTES)
}

/** A new signed host token issued at `now`. */
export async function newHostToken(secret: string, now = Date.now()): Promise<string> {
  const bytes = new Uint8Array(PAYLOAD_BYTES + TAG_BYTES)
  let time = now
  for (let i = TIME_BYTES - 1; i >= 0; i--) {
    bytes[i] = time % 256
    time = Math.floor(time / 256)
  }
  crypto.getRandomValues(bytes.subarray(TIME_BYTES, PAYLOAD_BYTES))
  bytes.set(new Uint8Array(await tag(secret, bytes.subarray(0, PAYLOAD_BYTES))), PAYLOAD_BYTES)
  return HOST_TOKEN_PREFIX + base64url(bytes)
}

/** Legacy credentials may reach existing rooms, but never carry an opening time. */
export async function verifyHostToken(
  token: string,
  secrets: HostTokenSecrets,
): Promise<VerifiedHostToken | undefined> {
  if (!token.startsWith(HOST_TOKEN_PREFIX)) {
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? { kind: 'legacy' } : undefined
  }
  if (!hostTokenConfigured(secrets)) return undefined
  if (token.length !== 55) return undefined
  const bytes = fromBase64url(token.slice(HOST_TOKEN_PREFIX.length))
  if (bytes?.length !== PAYLOAD_BYTES + TAG_BYTES) return undefined
  const payload = bytes.subarray(0, PAYLOAD_BYTES)
  const offered = bytes.slice(PAYLOAD_BYTES).buffer
  const keys = [secrets.HOST_TOKEN_SECRET, secrets.HOST_TOKEN_PREVIOUS_SECRET]
  let valid = false
  for (const secret of keys) {
    if (secret !== undefined) {
      const matches = crypto.subtle.timingSafeEqual(offered, await tag(secret, payload))
      valid = matches || valid
    }
  }
  if (!valid) return undefined
  let issued = 0
  for (const byte of payload.subarray(0, TIME_BYTES)) issued = issued * 256 + byte
  return { kind: 'signed', issued }
}

/** When a room's lifetime and its token's opening window have both ended. */
export function tokenEnd(issued: number, lifeSeconds: number): number {
  return issued + OPEN_WINDOW_MS + lifeSeconds * 1000
}
