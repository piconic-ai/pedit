// The Content-Security-Policy of the browser editor, and the media and frame
// sources that both the policy and the Markdown preview read. The Worker
// (packages/worker/src/page.ts) builds the header from the MEDIA_SOURCES var,
// which the web editor learns from a <meta> tag the Worker injects, and from the
// embed providers (embeds/index.ts), which both are built with.
// This is not part of the wire format, so internal/protocol has no mirror.

import { ALLOW_FEATURES, type Provider, type Providers, SANDBOX_EXTRAS } from './embeds/define.ts'
import PROVIDERS from './embeds/index.ts'

/** The embed providers this relay was built with (embeds/index.ts). */
export { PROVIDERS }

/** The id of one of those providers, as "Always load" remembers it. */
export type ProviderId = keyof typeof PROVIDERS

/** Hosts an avatar may come from. Awareness state is written by anyone with the link. */
export const AVATAR_HOSTS = [
  'gravatar.com',
  'www.gravatar.com',
  'secure.gravatar.com',
  'avatars.githubusercontent.com',
  'lh3.googleusercontent.com',
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

// https://host[:port]/path/, as written in frame-src. No '*', quotes, ';', ',', '%'
// or whitespace, so a prefix can never add a keyword or end a directive.
const FRAME_PREFIX =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?\/(?:[A-Za-z0-9._~-]+\/)*$/
const SANDBOX = new Set<string>(SANDBOX_EXTRAS)
const FEATURES = new Set<string>(ALLOW_FEATURES)
const RATIO = /^[1-9]\d{0,3}\/[1-9]\d{0,3}$/

/**
 * Why `provider` must not be framed on a page at `page`, or null if it may. The
 * types of defineProvider only hold at compile time; this checks them again,
 * and that no frame prefix covers the page's own origin (see coversOrigin).
 */
export function providerProblem(provider: Provider, page: URL): string | null {
  const p: Partial<Record<keyof Provider, unknown>> = provider
  if (typeof p.name !== 'string' || !p.name.trim()) return 'no name'
  if (!Array.isArray(p.frames) || p.frames.length === 0) return 'no frames'
  for (const frame of p.frames as unknown[]) {
    if (!validFrame(frame)) return `frame ${JSON.stringify(frame)} is not https://host/path/`
  }
  if (coversOrigin(p.frames as string[], page)) return "its frames cover the editor's own origin"
  const size = p.size
  if (
    typeof size !== 'function' &&
    !(typeof size === 'object' && size !== null && validSize(size as Record<string, unknown>))
  ) {
    return 'no valid size'
  }
  if (p.embed !== undefined && typeof p.embed !== 'function') return 'an embed that is no function'
  for (const [key, allowed] of [
    ['sandbox', SANDBOX],
    ['allow', FEATURES],
  ] as const) {
    const tokens = p[key] ?? []
    if (!Array.isArray(tokens) || !tokens.every((t) => allowed.has(t))) {
      return `a ${key} token it may not have`
    }
  }
  return null
}

// In the parser's own form too: lower-case host, no default port, no dot segments.
function validFrame(frame: unknown): boolean {
  if (typeof frame !== 'string' || !FRAME_PREFIX.test(frame)) return false
  try {
    return new URL(frame).href === frame
  } catch {
    return false
  }
}

function validSize(size: Record<string, unknown>): boolean {
  if ('ratio' in size) return typeof size.ratio === 'string' && RATIO.test(size.ratio)
  return Number.isInteger(size.height) && (size.height as number) > 0
}

/**
 * The providers the preview frames on a page at `page`, in order, and those it
 * refuses with the reason. The Worker builds frame-src from the same answer.
 */
export function framedProviders<P extends Providers = typeof PROVIDERS>(
  page: URL,
  providers: P = PROVIDERS as unknown as P,
): { framed: (keyof P & string)[]; refused: { id: string; reason: string }[] } {
  const framed: (keyof P & string)[] = []
  const refused: { id: string; reason: string }[] = []
  for (const [id, provider] of Object.entries(providers)) {
    const reason = providerProblem(provider, page)
    if (reason) refused.push({ id, reason })
    else framed.push(id)
  }
  return { framed, refused }
}

/**
 * The policy for one HTML response, on one line. `origin` is the request's URL;
 * `frames` are the frame prefixes of the providers framed there (framedProviders).
 */
export function contentSecurityPolicy(o: {
  scriptHashes: readonly string[]
  media: readonly string[]
  frames: readonly string[]
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
    `frame-src ${o.frames.length ? o.frames.join(' ') : "'none'"}`,
    `connect-src 'self' ${socket}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}
