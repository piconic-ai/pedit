import { framedProviders, PROVIDERS, type ProviderId } from '@pedit/protocol/csp'
import { allowOf, sandboxOf } from '@pedit/protocol/embeds/define'

/**
 * What pedit decides for a frame of one src: the URL to load, the provider that
 * serves it, its accessible title, and the sandbox and permissions it runs with.
 */
export type Frame = {
  /** The URL to load: rebuilt from the parsed src, starting with the provider's frame prefix. */
  src: string
  provider: ProviderId
  title: string
  sandbox: string
  allow: string
}

/** A player the preview shows in place of a bare URL or an image. */
export type Embed = ({ kind: 'frame' } & Frame) | { kind: 'video'; src: string }

// YouTube refuses to play without a referrer; the origin carries no room or key.
export const FRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin'

type Prefix = { provider: ProviderId; frame: string; origin: string; path: string }

// The registry is fixed at build time, so the answer only depends on the origin.
const framing = new Map<string, { ids: ProviderId[]; prefixes: Prefix[] }>()

/**
 * The providers framed on a page at `page`, as the Worker decided for the
 * policy: none whose frames would cover the editor's own origin, where a frame
 * with allow-same-origin could read the key.
 */
function framedOn(page: URL): { ids: ProviderId[]; prefixes: Prefix[] } {
  let out = framing.get(page.origin)
  if (!out) {
    const ids = framedProviders(page).framed
    const prefixes = ids.flatMap((provider) =>
      PROVIDERS[provider].frames.map((frame) => {
        const url = new URL(frame)
        return { provider, frame, origin: url.origin, path: url.pathname }
      }),
    )
    out = { ids, prefixes }
    framing.set(page.origin, out)
  }
  return out
}

const here = () => new URL(location.href)

// An encoded slash, backslash or dot could become a different path on the provider's server.
const ENCODED_SEPARATOR = /%(2f|5c|2e)/i

const VIDEO_FILE = /\.(mp4|m4v|mov|webm|ogv)$/i

/**
 * The URL if it is absolute http(s). Anything else, such as a path relative
 * to the host's file, cannot be loaded from the browser.
 */
export function httpUrl(href: string): URL | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
}

export function isVideoFile(url: URL): boolean {
  return VIDEO_FILE.test(url.pathname)
}

/**
 * The provider of a frame `src` and the attributes pedit gives it, or null if the
 * preview must not frame it on a page at `page`. Rendering, the sanitiser and
 * loading a frame on request all take its attributes from here, so they can only
 * be what pedit decides for that src.
 */
export function frameFor(src: string | null, page: URL = here()): Frame | null {
  if (src === null) return null
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return null
  }
  if (url.username || url.password || ENCODED_SEPARATOR.test(url.pathname)) return null
  if (url.protocol !== 'https:') return null
  // The parsed pathname has its dot segments resolved, unlike the raw string.
  const known = framedOn(page).prefixes.find(
    (p) => url.origin === p.origin && url.pathname.startsWith(p.path),
  )
  if (!known) return null
  const provider = PROVIDERS[known.provider]
  return {
    // Never the fragment: the player has no use for it.
    src: `${known.frame}${url.pathname.slice(known.path.length)}${url.search}`,
    provider: known.provider,
    title: provider.name,
    sandbox: sandboxOf(provider),
    allow: allowOf(provider),
  }
}

export function isAllowedFrame(src: string | null, page?: URL): boolean {
  return frameFor(src, page) !== null
}

// What the provider makes of a pasted URL. A provider's code runs on a copy, and
// a failure only means it does not take the URL.
function playerUrl(provider: ProviderId, url: URL): string | null {
  const { embed } = PROVIDERS[provider]
  if (!embed) return url.href
  try {
    const src = embed(new URL(url.href))
    return typeof src === 'string' ? src : null
  } catch {
    return null
  }
}

/**
 * What to show for a URL that stands alone in a paragraph, if anything: the
 * player of the first provider that takes it, a video file, or nothing.
 */
export function embedFor(href: string, page: URL = here()): Embed | null {
  const url = httpUrl(href)
  if (!url) return null
  for (const provider of framedOn(page).ids) {
    const src = playerUrl(provider, url)
    // What embed() built must still be under that provider's own frames.
    const f = frameFor(src, page)
    if (f?.provider === provider) {
      return { kind: 'frame', ...f }
    }
  }
  if (isVideoFile(url)) return { kind: 'video', src: url.href }
  return null
}
