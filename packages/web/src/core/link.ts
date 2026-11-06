import { FRAGMENT_PATTERN } from '@pedit/protocol'

export interface Link {
  id: string
  /** The fragment after the room id: an edit, `c.` comment-only or `r.` read-only key. */
  key: string
}

/**
 * Reads `#<room>.<fragment>`, a link that carries the room id too, so it
 * needs no path of its own. The room id is 22 characters of `[A-Za-z0-9_-]`
 * and the fragment is checked as the relay's own links are. The leading `#`
 * is optional.
 */
export function parseLink(hash: string): Link | null {
  const match = /^#?([A-Za-z0-9_-]{22})\.(.*)$/s.exec(hash)
  const key = match?.[2]
  if (!match?.[1] || key === undefined || !FRAGMENT_PATTERN.test(key)) return null
  return { id: match[1], key }
}
