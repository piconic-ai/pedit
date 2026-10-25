import { toBase64Url } from './key.ts'

export const ADMISSION_HEADER = 'X-Pedit-Admission'
/**
 * Carries the reader admission token (access.ts) on the host's upgrade
 * request, so the relay admits comment-only and read-only links too. The
 * host offers the editor token as its subprotocol, as every editor does.
 */
export const READ_ADMISSION_HEADER = 'X-Pedit-Read-Admission'
/**
 * The wire format version. Bump it only for changes older peers cannot skip;
 * adding a message type or kind does not need a bump.
 */
export const PROTOCOL_VERSION = 5
export const SOCKET_PROTOCOL = `pedit-v${PROTOCOL_VERSION}`
const VERSION_PROTOCOL = /^pedit-v(0|[1-9][0-9]{0,8})$/
export const ADMISSION_PROTOCOL_PREFIX = 'pedit-admission.'
export const ADMISSION_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * The relay capability of everyone in a room, from its frame key (access.ts),
 * domain-separated from every encryption key. Never send the frame key.
 */
export async function deriveAdmissionToken(frameSecret: Uint8Array): Promise<string> {
  const base = await crypto.subtle.importKey(
    'raw',
    frameSecret as Uint8Array<ArrayBuffer>,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: new TextEncoder().encode('pedit v5 read admission'),
    },
    base,
    256,
  )
  return toBase64Url(new Uint8Array(bits))
}

export function admissionProtocols(token: string): string[] {
  if (!ADMISSION_PATTERN.test(token)) throw new Error('invalid admission token')
  return [SOCKET_PROTOCOL, ADMISSION_PROTOCOL_PREFIX + token]
}

/** Require one capability and negotiate only the public protocol name. */
export function readAdmissionProtocol(header: string | null): string | null {
  const protocols = header?.split(',').map((p) => p.trim()) ?? []
  if (!protocols.includes(SOCKET_PROTOCOL)) return null
  const tokens = protocols.filter((p) => p.startsWith(ADMISSION_PROTOCOL_PREFIX))
  const token = tokens[0]?.slice(ADMISSION_PROTOCOL_PREFIX.length)
  return tokens.length === 1 && token && ADMISSION_PATTERN.test(token) ? token : null
}

/**
 * Compares the protocol versions a client offers with PROTOCOL_VERSION:
 * `current` when it speaks this one, `client-outdated` or `server-outdated`
 * when it only speaks others, and `none` when it offers no version at all.
 * `offered` is the subprotocol to echo when accepting just to close.
 */
export function checkProtocolVersion(
  header: string | null,
):
  | { result: 'current' | 'none' }
  | { result: 'client-outdated' | 'server-outdated'; offered: string } {
  const protocols = header?.split(',').map((p) => p.trim()) ?? []
  const versions = protocols.flatMap((p) => {
    const m = VERSION_PROTOCOL.exec(p)
    return m ? [{ protocol: p, version: Number(m[1]) }] : []
  })
  if (versions.length === 0) return { result: 'none' }
  if (versions.some((v) => v.version === PROTOCOL_VERSION)) return { result: 'current' }
  const newest = versions.reduce((a, b) => (b.version > a.version ? b : a))
  return {
    result: newest.version > PROTOCOL_VERSION ? 'server-outdated' : 'client-outdated',
    offered: newest.protocol,
  }
}
