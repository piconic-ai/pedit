import { AVATAR_HOSTS } from '@pedit/protocol/csp'

/**
 * Who the collaborator is, when pedit runs behind Cloudflare Access.
 *
 * Access answers `/cdn-cgi/access/get-identity` itself, so the Worker never
 * sees this request. The name and avatar only travel inside the encrypted
 * awareness state, like a name typed by hand.
 */
export interface Identity {
  name: string
  email?: string
  picture?: string
}

export const IDENTITY_PATH = '/cdn-cgi/access/get-identity'

export function parseIdentity(json: unknown): Identity | null {
  if (typeof json !== 'object' || json === null) return null
  const data = json as { name?: unknown; email?: unknown; oidc_fields?: unknown }
  const email = typeof data.email === 'string' && data.email.includes('@') ? data.email : undefined
  const name = (typeof data.name === 'string' ? data.name.trim() : '') || email?.split('@')[0]
  if (!name) return null
  const oidc = (typeof data.oidc_fields === 'object' ? data.oidc_fields : null) as {
    picture?: unknown
  } | null
  const picture = typeof oidc?.picture === 'string' ? oidc.picture : undefined
  return { name: name.slice(0, 40), ...(email && { email }), ...(picture && { picture }) }
}

/** Resolves to null when the page is not behind Access (or Access does not answer). */
export async function fetchIdentity(fetcher: typeof fetch = fetch): Promise<Identity | null> {
  try {
    const res = await fetcher(IDENTITY_PATH, {
      credentials: 'same-origin',
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return null
    return parseIdentity(await res.json())
  } catch {
    return null
  }
}

/**
 * Hosts an avatar may come from. Awareness state is written by anyone with the
 * link, so an arbitrary URL would let a peer make every browser in the room
 * fetch a tracking image.
 */
const avatarHosts = new Set<string>(AVATAR_HOSTS)

export function safeAvatar(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && avatarHosts.has(u.hostname) ? u.href : undefined
  } catch {
    return undefined
  }
}

/** Gravatar answers 404 (d=404) for unknown emails, so the UI can fall back to initials. */
export async function gravatarUrl(email: string): Promise<string> {
  const bytes = new TextEncoder().encode(email.trim().toLowerCase())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
  return `https://gravatar.com/avatar/${hex}?s=64&d=404`
}

/** The IdP's picture wins; otherwise Gravatar, if we know the email. */
export async function avatarFor(identity: Identity): Promise<string | undefined> {
  return (
    safeAvatar(identity.picture) ?? (identity.email ? await gravatarUrl(identity.email) : undefined)
  )
}

export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  const letters = words.length > 1 ? [words[0], words[1]] : [words[0]]
  return (
    letters
      .map((w) => (w ? Array.from(w)[0] : ''))
      .join('')
      .toUpperCase() || '?'
  )
}
