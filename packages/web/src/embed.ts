import { allowsFrame, FRAMES, type FrameProvider } from '@pedit/protocol/csp'
import { customProvider, type ProviderId } from './alwaysload.ts'

/** How a frame is laid out: a 16:9 player, a short audio bar or a tall document. */
export type Shape = 'video' | 'audio' | 'doc'

/**
 * What pedit decides for a frame of one src: who serves it, its accessible title,
 * its layout, and the sandbox and permissions it runs with.
 */
export type Frame = {
  /** The URL to load: rebuilt from the parsed src, starting with the allowed prefix. */
  src: string
  provider: FrameProvider | 'custom'
  title: string
  shape: Shape
  sandbox: string
  allow: string
}

/** A player the preview shows in place of a bare URL or an image. */
export type Embed = ({ kind: 'frame'; src: string } & Frame) | { kind: 'video'; src: string }

/** The extra frame sources a self-hosted relay allows (FRAME_SOURCES), and the page they apply to. */
export type FrameSources = { sources: readonly string[]; page: URL }

// YouTube refuses to play without a referrer; the origin carries no room or key.
export const FRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin'

const PLAYER = {
  shape: 'video',
  sandbox: 'allow-scripts allow-same-origin allow-popups allow-presentation',
  allow: 'fullscreen; picture-in-picture; encrypted-media',
} as const

const PROVIDERS: Record<FrameProvider, Omit<Frame, 'src' | 'provider'>> = {
  youtube: { title: 'YouTube video', ...PLAYER },
  vimeo: { title: 'Vimeo video', ...PLAYER },
}

// A frame from FRAME_SOURCES: the relay's operator chose the site, not its features.
const CUSTOM = {
  shape: 'video',
  sandbox: 'allow-scripts allow-same-origin allow-popups',
  allow: '',
} as const

const PREFIXES = (Object.keys(FRAMES) as FrameProvider[]).map((provider) => {
  const url = new URL(FRAMES[provider])
  return { provider, origin: url.origin, path: url.pathname }
})

// An encoded slash, backslash or dot could become a different path on the provider's server.
const ENCODED_SEPARATOR = /%(2f|5c|2e)/i

const VIDEO_FILE = /\.(mp4|m4v|mov|webm|ogv)$/i
const YOUTUBE_ID = /^[\w-]{11}$/

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
 * preview must not frame it. Rendering, the sanitiser and loading a frame on
 * request all take its attributes from here, so they can only be what pedit
 * decides for that src.
 */
export function frameFor(src: string | null, custom?: FrameSources): Frame | null {
  if (src === null) return null
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return null
  }
  if (url.username || url.password || ENCODED_SEPARATOR.test(url.pathname)) return null
  if (url.protocol === 'https:') {
    // The parsed pathname has its dot segments resolved, unlike the raw string.
    const known = PREFIXES.find((p) => url.origin === p.origin && url.pathname.startsWith(p.path))
    if (known) {
      const rest = `${url.pathname.slice(known.path.length)}${url.search}`
      return {
        src: `${FRAMES[known.provider]}${rest}`,
        provider: known.provider,
        ...PROVIDERS[known.provider],
      }
    }
  }
  if (custom && allowsFrame(custom.sources, url, custom.page)) {
    return { src: url.href, provider: 'custom', title: url.host, ...CUSTOM }
  }
  return null
}

export function isAllowedFrame(src: string | null, custom?: FrameSources): boolean {
  return frameFor(src, custom) !== null
}

/**
 * Who serves a frame `src`, as the "Always load" preference names it, or null if
 * the preview must not frame it. Like the frame itself, it comes from frameFor.
 */
export function providerOf(src: string | null, custom?: FrameSources): ProviderId | null {
  const frame = frameFor(src, custom)
  if (src === null || !frame) return null
  return frame.provider === 'custom' ? customProvider(new URL(src)) : frame.provider
}

/** Reads YouTube's `t=90` or `t=1m30s`. */
function seconds(t: string | null): number {
  if (!t) return 0
  if (/^\d+$/.test(t)) return Number(t)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
  if (!m) return 0
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

function youtube(url: URL): string | null {
  const host = url.hostname.replace(/^(www|m)\./, '')
  const [, first, second] = url.pathname.split('/')
  let id: string | null | undefined
  if (host === 'youtu.be') {
    id = first
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (first === 'watch') id = url.searchParams.get('v')
    else if (first === 'shorts' || first === 'embed' || first === 'live') id = second
  }
  if (!id || !YOUTUBE_ID.test(id)) return null
  const start = seconds(url.searchParams.get('t') ?? url.searchParams.get('start'))
  // The no-cookie player does not set tracking cookies until playback starts.
  return `${FRAMES.youtube}${id}${start ? `?start=${start}` : ''}`
}

function vimeo(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '')
  const m =
    host === 'vimeo.com'
      ? /^\/(\d+)(?:\/([\da-f]+))?\/?$/.exec(url.pathname)
      : host === 'player.vimeo.com'
        ? /^\/video\/(\d+)\/?$/.exec(url.pathname)
        : null
  if (!m) return null
  // Unlisted videos need their hash, either in the path or as ?h=.
  const hash = m[2] ?? url.searchParams.get('h')
  const query = hash && /^[\da-f]+$/.test(hash) ? `?h=${hash}` : ''
  return `${FRAMES.vimeo}${m[1]}${query}`
}

function frame(src: string | null, custom?: FrameSources): Embed | null {
  const f = frameFor(src, custom)
  return f ? { kind: 'frame', ...f } : null
}

/**
 * What to show for a URL that stands alone in a paragraph, if anything. `custom`
 * are the relay's FRAME_SOURCES, framed as they are.
 */
export function embedFor(href: string, custom?: FrameSources): Embed | null {
  const url = httpUrl(href)
  if (!url) return null
  const player = frame(youtube(url)) ?? frame(vimeo(url))
  if (player) return player
  if (isVideoFile(url)) return { kind: 'video', src: url.href }
  // Only FRAME_SOURCES are framed as they are; a player URL that youtube() or
  // vimeo() did not take stays a link, as it does without frame sources.
  const f = frameFor(url.href, custom)
  return f?.provider === 'custom' ? { kind: 'frame', ...f } : null
}
