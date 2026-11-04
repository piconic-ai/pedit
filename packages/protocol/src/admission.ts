import { toBase64Url } from './key.ts'

export const ADMISSION_HEADER = 'X-Pedit-Admission'
/**
 * Carries the reader admission token (access.ts) on the host's upgrade
 * request, so the relay admits comment-only and read-only links too. The
 * host offers the editor token as its subprotocol, as every editor does.
 */
export const READ_ADMISSION_HEADER = 'X-Pedit-Read-Admission'
/**
 * Carries the comment admission token (access.ts) on the host's upgrade
 * request, beside READ_ADMISSION_HEADER, so the relay can tell a comment link
 * from a read link (docs/design/kept-comments.md). Like the read token, the
 * relay hashes it before keeping it. Honoured from the host only.
 */
export const COMMENT_ADMISSION_HEADER = 'X-Pedit-Comment-Admission'
/**
 * The wire format version. Bump it only for changes older peers cannot skip;
 * adding a message type or kind does not need a bump. Version 6 starts every
 * binary message with a kind byte (kinds.ts). This is the version this
 * client speaks and offers; the relay serves up to RELAY_PROTOCOL_VERSION.
 */
export const PROTOCOL_VERSION = 7
/**
 * The newest version the relay serves. Version 8 adds the commenter role
 * (docs/design/kept-comments.md); clients keep offering version 7 until they
 * speak it, so the relay can ship first.
 */
export const RELAY_PROTOCOL_VERSION = 8
/** Older peers cannot replay kept canvas documents. */
export const MIN_PROTOCOL_VERSION = 7
export const SOCKET_PROTOCOL = `pedit-v${PROTOCOL_VERSION}`
/** The subprotocol name of a version. */
export const socketProtocol = (version: number) => `pedit-v${version}`
const VERSION_PROTOCOL = /^pedit-v(0|[1-9][0-9]{0,8})$/
export const ADMISSION_PROTOCOL_PREFIX = 'pedit-admission.'
/**
 * Offered beside the reader token by a link that can derive the comment
 * token. It does not start with ADMISSION_PROTOCOL_PREFIX, so a relay that
 * does not know it never counts it as a second reader token.
 */
export const COMMENT_ADMISSION_PROTOCOL_PREFIX = 'pedit-comment-admission.'
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

export function admissionProtocols(token: string, version = PROTOCOL_VERSION): string[] {
  if (!ADMISSION_PATTERN.test(token)) throw new Error('invalid admission token')
  return [socketProtocol(version), ADMISSION_PROTOCOL_PREFIX + token]
}

/**
 * The versions a version 8 client offers, newest first, so a version 7 relay
 * still accepts it (docs/design/kept-comments.md, "Version negotiation").
 * Nothing offers them yet: PROTOCOL_VERSION stays 7 until the clients speak 8.
 */
export const CLIENT_PROTOCOL_VERSIONS = [8, 7] as const

/**
 * What a client offers as subprotocols: `versions` (newest first), the reader
 * or editor admission token and, if it holds one, the comment admission token.
 */
export function offerProtocols(
  token: string,
  commentToken: string | null = null,
  versions: readonly number[] = CLIENT_PROTOCOL_VERSIONS,
): string[] {
  if (!ADMISSION_PATTERN.test(token) || (commentToken && !ADMISSION_PATTERN.test(commentToken)))
    throw new Error('invalid admission token')
  return [
    ...versions.map(socketProtocol),
    ADMISSION_PROTOCOL_PREFIX + token,
    ...(commentToken ? [COMMENT_ADMISSION_PROTOCOL_PREFIX + commentToken] : []),
  ]
}

/** The version a socket's accepted subprotocol names (`pedit-v8` is 8), or undefined. */
export function acceptedVersion(protocol: string | null | undefined): number | undefined {
  const m = protocol ? VERSION_PROTOCOL.exec(protocol) : null
  return m ? Number(m[1]) : undefined
}

/** Require one capability and negotiate only the public protocol name. */
export function readAdmissionProtocol(header: string | null): string | null {
  const protocols = header?.split(',').map((p) => p.trim()) ?? []
  if (!protocols.some((p) => servedVersion(p) !== undefined)) return null
  const tokens = protocols.filter((p) => p.startsWith(ADMISSION_PROTOCOL_PREFIX))
  const token = tokens[0]?.slice(ADMISSION_PROTOCOL_PREFIX.length)
  return tokens.length === 1 && token && ADMISSION_PATTERN.test(token) ? token : null
}

/** The comment token a client offered beside its reader token, or null. */
export function commentAdmissionProtocol(header: string | null): string | null {
  const protocols = header?.split(',').map((p) => p.trim()) ?? []
  const tokens = protocols.filter((p) => p.startsWith(COMMENT_ADMISSION_PROTOCOL_PREFIX))
  const token = tokens[0]?.slice(COMMENT_ADMISSION_PROTOCOL_PREFIX.length)
  return tokens.length === 1 && token && ADMISSION_PATTERN.test(token) ? token : null
}

function servedVersion(protocol: string): number | undefined {
  const m = VERSION_PROTOCOL.exec(protocol)
  const version = m ? Number(m[1]) : 0
  return version >= MIN_PROTOCOL_VERSION && version <= RELAY_PROTOCOL_VERSION ? version : undefined
}

/**
 * Compares the protocol versions a client offers with those the relay serves
 * (MIN_PROTOCOL_VERSION to RELAY_PROTOCOL_VERSION): `current` when it speaks one,
 * with the newest of those as `version`, `client-outdated` or
 * `server-outdated` when it only speaks others, and `none` when it offers no
 * version at all. `offered` is the subprotocol to echo when accepting just to
 * close.
 */
export function checkProtocolVersion(
  header: string | null,
):
  | { result: 'current'; version: number }
  | { result: 'none' }
  | { result: 'client-outdated' | 'server-outdated'; offered: string } {
  const protocols = header?.split(',').map((p) => p.trim()) ?? []
  const versions = protocols.flatMap((p) => {
    const m = VERSION_PROTOCOL.exec(p)
    return m ? [{ protocol: p, version: Number(m[1]) }] : []
  })
  if (versions.length === 0) return { result: 'none' }
  const served = versions.filter((v) => servedVersion(v.protocol) !== undefined)
  if (served.length > 0) {
    return { result: 'current', version: Math.max(...served.map((v) => v.version)) }
  }
  const newest = versions.reduce((a, b) => (b.version > a.version ? b : a))
  return {
    result: newest.version > RELAY_PROTOCOL_VERSION ? 'server-outdated' : 'client-outdated',
    offered: newest.protocol,
  }
}
