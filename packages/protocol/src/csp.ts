// The Content-Security-Policy of the browser editor, and the list of media
// sources that both the policy and the Markdown preview read. The Worker
// (packages/worker/src/page.ts) builds the header from the MEDIA_SOURCES var;
// the web editor learns the same list from a <meta> tag the Worker injects.
// This is not part of the wire format, so internal/protocol has no mirror.

/** Hosts an avatar may come from. Awareness state is written by anyone with the link. */
export const AVATAR_HOSTS = [
  'gravatar.com',
  'www.gravatar.com',
  'secure.gravatar.com',
  'avatars.githubusercontent.com',
  'lh3.googleusercontent.com',
] as const

/** Players the preview may frame; the sanitiser drops any other iframe. */
export const FRAME_PREFIXES = [
  'https://www.youtube-nocookie.com/embed/',
  'https://player.vimeo.com/video/',
] as const

/** The <meta name> through which the Worker tells the editor the allowed media sources. */
export const MEDIA_META = 'pedit-media-sources'
export const MAX_MEDIA_SOURCES = 32

const SCHEME_SOURCE = /^https?:$/i
// [scheme://][*.]host[:port|:*][/path]. No quotes, ';', ',', '&', '<', '>' or whitespace,
// so a value can never end a directive or add a keyword ('unsafe-inline', *, data:, blob:).
const HOST_SOURCE =
  /^(?:(https?):\/\/)?(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}|\*))?(\/[A-Za-z0-9._~%/-]*)?$/i

/** Parses MEDIA_SOURCES. Unset or blank gives []; any invalid token gives null (callers use []). */
export function parseMediaSources(value: string | undefined): string[] | null {
  const tokens = (value ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length > MAX_MEDIA_SOURCES) return null
  return tokens.every((t) => SCHEME_SOURCE.test(t) || HOST_SOURCE.test(t)) ? tokens : null
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' }

function allowsBy(source: string, url: URL, page: URL): boolean {
  if (SCHEME_SOURCE.test(source)) return schemeMatches(source.toLowerCase().slice(0, -1), url)
  const m = HOST_SOURCE.exec(source)
  if (!m) return false
  const [, scheme, wildcard, host = '', port, path] = m
  if (!schemeMatches((scheme ?? page.protocol.slice(0, -1)).toLowerCase(), url)) return false
  const hostname = url.hostname.toLowerCase()
  const want = host.toLowerCase()
  if (wildcard ? !hostname.endsWith(`.${want}`) : hostname !== want) return false
  if (port === undefined) {
    if (url.port !== '') return false
  } else if (port !== '*') {
    const ok = url.port === port || (url.port === '' && DEFAULT_PORTS[url.protocol] === port)
    if (!ok) return false
  }
  if (path !== undefined) {
    return path.endsWith('/') ? url.pathname.startsWith(path) : url.pathname === path
  }
  return true
}

// 'http' also covers https, as browsers upgrade.
function schemeMatches(scheme: string, url: URL): boolean {
  if (scheme === 'https') return url.protocol === 'https:'
  return scheme === 'http' && (url.protocol === 'http:' || url.protocol === 'https:')
}

/**
 * Whether the browser would load `url` under img-src/media-src `sources`, for a page
 * at `page`. A conservative subset of CSP3 "does url match expression": when unsure it
 * answers false, which only costs a placeholder; the browser enforces the header anyway.
 */
export function allowsMedia(sources: readonly string[], url: URL, page: URL): boolean {
  return sources.some((s) => allowsBy(s, url, page))
}

/** The policy for one HTML response, on one line. `origin` is the request's URL. */
export function contentSecurityPolicy(o: {
  scriptHashes: readonly string[]
  media: readonly string[]
  origin: URL
}): string {
  const socket = `${o.origin.protocol === 'https:' ? 'wss' : 'ws'}://${o.origin.host}`
  const hashes = o.scriptHashes.map((h) => ` 'sha256-${h}'`).join('')
  const avatars = AVATAR_HOSTS.map((h) => `https://${h}`).join(' ')
  return [
    "default-src 'none'",
    `script-src 'self'${hashes}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${avatars}${o.media.map((m) => ` ${m}`).join('')}`,
    `media-src ${o.media.length ? o.media.join(' ') : "'none'"}`,
    `frame-src ${FRAME_PREFIXES.join(' ')}`,
    `connect-src 'self' ${socket}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}
