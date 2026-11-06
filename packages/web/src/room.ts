import { FRAGMENT_PATTERN } from '@pedit/protocol'

export interface RoomLocation {
  id: string
  key: string
}

/**
 * Reads `/r/<id>#<key>`: an edit, comment-only or read-only link (access.ts).
 * The key lives only in the fragment, which browsers never send.
 */
export function parseRoomLocation(loc: { pathname: string; hash: string }): RoomLocation | null {
  const match = /^\/r\/([A-Za-z0-9_-]{22})\/?$/.exec(loc.pathname)
  const key = loc.hash.replace(/^#/, '')
  if (!match?.[1] || !FRAGMENT_PATTERN.test(key)) return null
  return { id: match[1], key }
}
