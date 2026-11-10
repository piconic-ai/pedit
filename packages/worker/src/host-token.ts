/**
 * Host tokens carry the time the relay issued them, so a room can tell how
 * old its ID is without remembering anything: a room opens only with a token
 * issued in the last OPEN_WINDOW_MS, and once that token is too old to open
 * it again, the room can delete its last record (#526).
 *
 * A token is HOST_TOKEN_PREFIX, then base64url of 6 bytes (the issue time, in
 * ms since the epoch, big-endian) and 23 random bytes: 43 characters, like the
 * random tokens before it. Clients treat it as opaque. The time is not signed:
 * a token made up with a chosen time only names a room of its own.
 */

const HOST_TOKEN_PREFIX = 'pe1_'
const TIME_BYTES = 6
const RANDOM_BYTES = 23

/** How long after its issue a host token may still open a room. */
export const OPEN_WINDOW_MS = 24 * 60 * 60 * 1000

/** How far ahead of the room's clock an issue time may be. */
export const ISSUE_SKEW_MS = 5 * 60 * 1000

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array | undefined {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(binary, (c) => c.charCodeAt(0))
  } catch {
    return undefined
  }
}

/** A new host token issued at `now`. */
export function newHostToken(now = Date.now()): string {
  const bytes = new Uint8Array(TIME_BYTES + RANDOM_BYTES)
  let time = now
  for (let i = TIME_BYTES - 1; i >= 0; i--) {
    bytes[i] = time % 256
    time = Math.floor(time / 256)
  }
  crypto.getRandomValues(bytes.subarray(TIME_BYTES))
  return HOST_TOKEN_PREFIX + base64url(bytes)
}

/** When a host token was issued, or undefined for a token without a time (the old format). */
export function tokenIssuedAt(token: string): number | undefined {
  if (!token.startsWith(HOST_TOKEN_PREFIX)) return undefined
  const bytes = fromBase64url(token.slice(HOST_TOKEN_PREFIX.length))
  if (bytes?.length !== TIME_BYTES + RANDOM_BYTES) return undefined
  let time = 0
  for (const byte of bytes.subarray(0, TIME_BYTES)) time = time * 256 + byte
  return time
}

/**
 * When a room opened with a token issued at `issued` has no more use for its
 * record: its life (`lifeSeconds` from an opening within OPEN_WINDOW_MS of
 * the issue) is over, and the token can no longer open the ID again.
 */
export function tokenEnd(issued: number, lifeSeconds: number): number {
  return issued + OPEN_WINDOW_MS + lifeSeconds * 1000
}
