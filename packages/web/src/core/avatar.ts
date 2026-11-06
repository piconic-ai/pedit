import { AVATAR_HOSTS } from '@pedit/protocol/csp'

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
