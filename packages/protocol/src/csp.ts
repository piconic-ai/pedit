// The Content-Security-Policy of the browser editor, and the lists of media and
// frame sources that both the policy and the Markdown preview read. The Worker
// (packages/worker/src/page.ts) builds the header from the MEDIA_SOURCES and
// FRAME_SOURCES vars; the web editor learns the same lists from <meta> tags the
// Worker injects.
// This is not part of the wire format, so internal/protocol has no mirror.

/** Hosts an avatar may come from. Awareness state is written by anyone with the link. */
export const AVATAR_HOSTS = [
  'gravatar.com',
  'www.gravatar.com',
  'secure.gravatar.com',
  'avatars.githubusercontent.com',
  'lh3.googleusercontent.com',
] as const

/**
 * Where each provider's players are served from, by provider: the frame-src
 * sources pedit allows for it, in order. The preview frames these and any
 * FRAME_SOURCES; the sanitiser drops any other iframe. Each is a path prefix,
 * apart from CodePen: it serves players at /{user}/embed/{slug}, which no
 * prefix can name, so its whole origin is allowed and the editor checks the path.
 */
export const FRAMES = {
  youtube: ['https://www.youtube-nocookie.com/embed/'],
  vimeo: ['https://player.vimeo.com/video/'],
  loom: ['https://www.loom.com/embed/'],
  figma: [
    'https://embed.figma.com/design/',
    'https://embed.figma.com/board/',
    'https://embed.figma.com/slides/',
    'https://embed.figma.com/deck/',
    'https://embed.figma.com/proto/',
  ],
  codepen: ['https://codepen.io/'],
  stackblitz: ['https://stackblitz.com/edit/', 'https://stackblitz.com/github/'],
  observable: ['https://observablehq.com/embed/'],
  spotify: ['https://open.spotify.com/embed/'],
  soundcloud: ['https://w.soundcloud.com/player/'],
  miro: ['https://miro.com/app/live-embed/'],
} as const

export type FrameProvider = keyof typeof FRAMES

/** Every source in FRAMES, in the order frame-src lists them. */
export const FRAME_PREFIXES: readonly string[] = Object.values(FRAMES).flat()

/** The <meta name> through which the Worker tells the editor the allowed media sources. */
export const MEDIA_META = 'pedit-media-sources'
export const MAX_MEDIA_SOURCES = 32

/** The <meta name> through which the Worker tells the editor the extra frame sources. */
export const FRAME_META = 'pedit-frame-sources'
export const MAX_FRAME_SOURCES = 32

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

/**
 * Parses FRAME_SOURCES. Like MEDIA_SOURCES, but every token must name a host: a
 * scheme alone (https:) or '*' would let a document frame any site. Unset or blank
 * gives []; any invalid token gives null (callers use []).
 */
export function parseFrameSources(value: string | undefined): string[] | null {
  const tokens = (value ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length > MAX_FRAME_SOURCES) return null
  return tokens.every((t) => HOST_SOURCE.test(t)) ? tokens : null
}

/**
 * Whether any of `sources` would let `page`'s own origin be framed. The preview's
 * frames may run scripts with allow-same-origin, which on the editor's origin
 * escapes the sandbox and could read the key; such a list must be refused.
 */
export function coversOrigin(sources: readonly string[], page: URL): boolean {
  return sources.some((s) => allowsBy(s, page, page, false))
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' }

function allowsBy(source: string, url: URL, page: URL, withPath = true): boolean {
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
    // CSP3 lets :80 match https on its default port too, as browsers upgrade.
    const ok =
      url.port === port ||
      (url.port === '' &&
        (DEFAULT_PORTS[url.protocol] === port || (port === '80' && url.protocol === 'https:')))
    if (!ok) return false
  }
  if (withPath && path !== undefined) {
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

/**
 * Whether the preview may frame `url` from FRAME_SOURCES `sources`, for a page at
 * `page`. Stricter than the browser: https only, unless a source names http://
 * itself; no user-info; never the page's own origin.
 */
export function allowsFrame(sources: readonly string[], url: URL, page: URL): boolean {
  if (url.username || url.password || url.origin === page.origin) return false
  if (url.protocol === 'http:')
    return sources.some((s) => /^http:\/\//i.test(s) && allowsBy(s, url, page))
  return url.protocol === 'https:' && sources.some((s) => allowsBy(s, url, page))
}

/**
 * The policy for one HTML response, on one line. `origin` is the request's URL;
 * `frames` are the FRAME_SOURCES, which must not cover it (see coversOrigin).
 */
export function contentSecurityPolicy(o: {
  scriptHashes: readonly string[]
  media: readonly string[]
  frames?: readonly string[]
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
    `frame-src ${[...FRAME_PREFIXES, ...(o.frames ?? [])].join(' ')}`,
    `connect-src 'self' ${socket}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}
