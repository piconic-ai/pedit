import { FRAME_PREFIXES } from '@pedit/protocol/csp'

/** A video the preview shows in place of a bare URL or an image. */
export type Embed = { kind: 'frame'; src: string; title: string } | { kind: 'video'; src: string }

/** Players the preview may frame; the sanitiser drops any other iframe. */
export { FRAME_PREFIXES }

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

export function isAllowedFrame(src: string | null): boolean {
  return src !== null && FRAME_PREFIXES.some((prefix) => src.startsWith(prefix))
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
  return `${FRAME_PREFIXES[0]}${id}${start ? `?start=${start}` : ''}`
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
  return `${FRAME_PREFIXES[1]}${m[1]}${query}`
}

/** What to show for a URL that stands alone in a paragraph, if anything. */
export function embedFor(href: string): Embed | null {
  const url = httpUrl(href)
  if (!url) return null
  const yt = youtube(url)
  if (yt) return { kind: 'frame', src: yt, title: 'YouTube video' }
  const vm = vimeo(url)
  if (vm) return { kind: 'frame', src: vm, title: 'Vimeo video' }
  if (isVideoFile(url)) return { kind: 'video', src: url.href }
  return null
}
