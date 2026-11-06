import { AVATAR_HOSTS } from '@pedit/protocol/avatar-hosts'

export interface ReviewCSPOptions {
  /** The relay the page's `<pedit-review relay="…">` talks to. */
  relay: string | URL
  /**
   * Who may frame the page: `'none'`, `'self'` or origins. Left out, the policy
   * has no `frame-ancestors`: that is the integrator's choice.
   */
  frameAncestors?: string | readonly string[]
}

// One source expression: a keyword or a scheme, host and port. No quote, ';' or
// ',' beyond the two keywords, so a value can never end the directive.
const ANCESTOR = /^(?:'self'|'none'|[A-Za-z0-9*.:/_-]+)$/

/**
 * The Content-Security-Policy for a page that holds `<pedit-review>`: send it as
 * the page's response header. The page's own script and styles, images from
 * itself, blobs and the avatar hosts, and connections to the relay only.
 * A relay's path is not kept: the policy admits the relay's whole origin.
 */
export function reviewCSP(options: ReviewCSPOptions): string {
  const relay = new URL(options.relay)
  if (
    (relay.protocol !== 'https:' && relay.protocol !== 'http:') ||
    relay.username ||
    relay.password
  )
    throw new Error('relay must be an http(s) URL without credentials')
  const socket = `${relay.protocol === 'https:' ? 'wss' : 'ws'}://${relay.host}`
  const avatars = AVATAR_HOSTS.map((h) => `https://${h}`).join(' ')
  const directives = [
    `default-src 'none'`,
    `script-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: ${avatars}`,
    `connect-src ${relay.origin} ${socket}`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `object-src 'none'`,
  ]
  if (options.frameAncestors !== undefined) {
    const list =
      typeof options.frameAncestors === 'string'
        ? options.frameAncestors.split(/\s+/).filter(Boolean)
        : [...options.frameAncestors]
    if (list.length === 0 || !list.every((s) => ANCESTOR.test(s)))
      throw new Error('frameAncestors must be source expressions')
    directives.push(`frame-ancestors ${list.join(' ')}`)
  }
  return directives.join('; ')
}
