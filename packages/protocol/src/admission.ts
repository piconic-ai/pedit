import { decodeKey, toBase64Url } from './key.ts'

export const ADMISSION_HEADER = 'X-Pedit-Admission'
/**
 * The wire format version. Bump it only for changes older peers cannot skip;
 * adding a message type or kind does not need a bump.
 */
export const PROTOCOL_VERSION = 3
export const SOCKET_PROTOCOL = `pedit-v${PROTOCOL_VERSION}`
const VERSION_PROTOCOL = /^pedit-v(0|[1-9][0-9]{0,8})$/
export const ADMISSION_PROTOCOL_PREFIX = 'pedit-admission.'
export const ADMISSION_PATTERN = /^[A-Za-z0-9_-]{43}$/

/** Relay capability, domain-separated from every encryption key. Never send the room key. */
export async function deriveAdmissionToken(roomKey: string): Promise<string> {
  const base = await crypto.subtle.importKey(
    'raw',
    decodeKey(roomKey) as Uint8Array<ArrayBuffer>,
    'HKDF',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: new TextEncoder().encode('pedit admission v1'),
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
