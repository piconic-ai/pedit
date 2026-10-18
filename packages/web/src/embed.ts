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

// Every other provider's links, such as "Open in Figma" or "Edit on CodePen",
// open a new tab, which must leave the sandbox to work as the provider's page.
const POPUPS = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox'

const PROVIDERS: Record<FrameProvider, Omit<Frame, 'src' | 'provider'>> = {
  youtube: { title: 'YouTube video', ...PLAYER },
  vimeo: { title: 'Vimeo video', ...PLAYER },
  loom: {
    title: 'Loom video',
    shape: 'video',
    sandbox: `${POPUPS} allow-presentation`,
    allow: 'fullscreen; autoplay',
  },
  // Forms for signing in to a file that is not public.
  figma: {
    title: 'Figma file',
    shape: 'doc',
    sandbox: `${POPUPS} allow-forms`,
    allow: 'fullscreen; clipboard-write',
  },
  // Pens commonly use forms and alert().
  codepen: {
    title: 'CodePen pen',
    shape: 'doc',
    sandbox: `${POPUPS} allow-forms allow-modals`,
    allow: 'fullscreen; clipboard-write',
  },
  // Not clipboard-read: the clipboard may hold this room's link, key and all.
  stackblitz: {
    title: 'StackBlitz project',
    shape: 'doc',
    sandbox: `${POPUPS} allow-forms allow-modals`,
    allow: 'cross-origin-isolated; clipboard-write; fullscreen',
  },
  observable: {
    title: 'Observable notebook',
    shape: 'doc',
    sandbox: POPUPS,
    allow: 'fullscreen; clipboard-write',
  },
  // Without encrypted-media Spotify plays only previews.
  spotify: {
    title: 'Spotify player',
    shape: 'audio',
    sandbox: `${POPUPS} allow-presentation`,
    allow: 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
  },
  soundcloud: { title: 'SoundCloud player', shape: 'audio', sandbox: POPUPS, allow: 'autoplay' },
  // Forms for signing in to a board that is not public.
  miro: {
    title: 'Miro board',
    shape: 'doc',
    sandbox: `${POPUPS} allow-forms`,
    allow: 'fullscreen',
  },
}

// A frame from FRAME_SOURCES: the relay's operator chose the site, not its features.
const CUSTOM = {
  shape: 'video',
  sandbox: 'allow-scripts allow-same-origin allow-popups',
  allow: '',
} as const

const PREFIXES = (Object.keys(FRAMES) as FrameProvider[]).flatMap((provider) =>
  FRAMES[provider].map((prefix) => {
    const url = new URL(prefix)
    return { provider, prefix, origin: url.origin, path: url.pathname }
  }),
)

// An encoded slash, backslash or dot could become a different path on the provider's server.
const ENCODED_SEPARATOR = /%(2f|5c|2e)/i

const VIDEO_FILE = /\.(mp4|m4v|mov|webm|ogv)$/i
const YOUTUBE_ID = /^[\w-]{11}$/
const LOOM_PATH = /^\/(?:share|embed)\/([\da-f]{32})\/?$/
// The legacy /file/ links open in Figma Design; a file's name after its key is left out.
const FIGMA_PATH =
  /^\/(design|board|slides|deck|proto|file)\/([A-Za-z0-9]{22,128})(?:\/[^/]{1,300})?\/?$/
const FIGMA_NODE = /^\d{1,10}[-:]\d{1,10}$/
const CODEPEN_PATH = /^\/([\w-]{1,64})\/(?:pen|embed|full|details)\/([A-Za-z0-9]{1,32})\/?$/
// The one shape of path codepen.io serves players at: frame-src allows its whole origin.
const CODEPEN_PLAYER = /^\/[\w-]{1,64}\/embed\/[A-Za-z0-9]{1,32}\/?$/
const CODEPEN_TABS = /^(?:html|css|js|result)(?:,(?:html|css|js|result))?$/
const GITHUB_NAME = '[\\w-][\\w.-]{0,99}'
const STACKBLITZ_PATH = new RegExp(
  `^/(?:edit/[\\w-]{1,100}|github/${GITHUB_NAME}/${GITHUB_NAME}(?:/tree(?:/${GITHUB_NAME}){1,20})?)/?$`,
)
// A file in the project: no empty, '.' or '..' segments.
const STACKBLITZ_FILE = /^(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[\w.-]+(?:\/[\w.-]+){0,19}$/
const STACKBLITZ_VIEW = /^(?:editor|preview|both)$/
const OBSERVABLE_PATH = /^\/(?:embed\/)?(@[\w-]{1,64}\/[\w-]{1,128})\/?$/
const OBSERVABLE_CELLS = /^[A-Za-z_$][\w$]{0,63}(?:,[A-Za-z_$][\w$]{0,63}){0,31}$/
// A share link may name the listener's locale (/intl-de/), which the player does not take.
const SPOTIFY_PATH =
  /^\/(?:embed\/|intl-[a-z]{2}(?:-[A-Za-z]{2,4})?\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})\/?$/
const SOUNDCLOUD_PATH = /^\/player\/?$/
// Share > Embed names a track or playlist of the API, by its number or its URN.
const SOUNDCLOUD_TARGET =
  /^\/(tracks|playlists)\/(?:soundcloud(?::|%3[Aa])(tracks|playlists)(?::|%3[Aa]))?(\d{1,20})$/
// Board ids often end in '=', which links may carry encoded.
const MIRO_PATH = /^\/app\/(?:board|live-embed)\/([\w-]{8,40}={0,2})\/?$/

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
      const { provider } = known
      if (provider === 'codepen' && !CODEPEN_PLAYER.test(url.pathname)) return null
      // YouTube and Vimeo keep what follows their prefix; the others load only
      // what their converter rebuilds from the ids it finds.
      const src =
        provider === 'youtube' || provider === 'vimeo'
          ? `${known.prefix}${url.pathname.slice(known.path.length)}${url.search}`
          : CONVERTERS[provider](url)
      return src ? { src, provider, ...PROVIDERS[provider] } : null
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
  return `${FRAMES.youtube[0]}${id}${start ? `?start=${start}` : ''}`
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
  return `${FRAMES.vimeo[0]}${m[1]}${query}`
}

/**
 * Whether `url` is on one of `hosts`, compared exactly, and could be one of its
 * links: no user-info, port or encoded separator, which none of them carry.
 */
function onHost(url: URL, ...hosts: string[]): boolean {
  if (url.username || url.password || url.port || ENCODED_SEPARATOR.test(url.pathname)) return false
  return hosts.includes(url.hostname)
}

function loom(url: URL): string | null {
  const m = onHost(url, 'loom.com', 'www.loom.com') ? LOOM_PATH.exec(url.pathname) : null
  if (!m) return null
  // Where to start, in seconds; Loom's other parameters are left behind.
  const t = url.searchParams.get('t')
  return `${FRAMES.loom[0]}${m[1]}${t && /^\d{1,6}$/.test(t) ? `?t=${t}` : ''}`
}

function figma(url: URL): string | null {
  const embed = onHost(url, 'embed.figma.com')
  if (!embed && !onHost(url, 'figma.com', 'www.figma.com')) return null
  const m = FIGMA_PATH.exec(url.pathname)
  if (!m || (embed && m[1] === 'file')) return null
  const type = m[1] === 'file' ? 'design' : m[1]
  // Figma requires embed-host, naming the site the file is shown on.
  let src = `https://embed.figma.com/${type}/${m[2]}?embed-host=pedit`
  for (const name of ['node-id', 'starting-point-node-id']) {
    const node = url.searchParams.get(name)
    if (node && FIGMA_NODE.test(node)) src += `&${name}=${node}`
  }
  return src
}

function codepen(url: URL): string | null {
  const m = onHost(url, 'codepen.io') ? CODEPEN_PATH.exec(url.pathname) : null
  if (!m) return null
  const tab = url.searchParams.get('default-tab')
  return `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=${tab && CODEPEN_TABS.test(tab) ? tab : 'result'}`
}

function stackblitz(url: URL): string | null {
  if (!onHost(url, 'stackblitz.com') || !STACKBLITZ_PATH.test(url.pathname)) return null
  // Every segment of the path is checked above; the query is rebuilt.
  let src = `https://stackblitz.com${url.pathname.replace(/\/$/, '')}?embed=1`
  const file = url.searchParams.get('file')
  if (file && STACKBLITZ_FILE.test(file)) src += `&file=${file}`
  const view = url.searchParams.get('view')
  if (view && STACKBLITZ_VIEW.test(view)) src += `&view=${view}`
  return src
}

function observable(url: URL): string | null {
  const m = onHost(url, 'observablehq.com') ? OBSERVABLE_PATH.exec(url.pathname) : null
  if (!m) return null
  // Only the named cells, if any: the whole notebook otherwise.
  const cells = url.searchParams.get('cells')
  return `${FRAMES.observable[0]}${m[1]}${cells && OBSERVABLE_CELLS.test(cells) ? `?cells=${cells}` : ''}`
}

function spotify(url: URL): string | null {
  const m = onHost(url, 'open.spotify.com') ? SPOTIFY_PATH.exec(url.pathname) : null
  return m ? `${FRAMES.spotify[0]}${m[1]}/${m[2]}` : null
}

/**
 * SoundCloud's player names what it plays in its url= parameter, which no
 * frame-src can check: only a track or playlist of SoundCloud's API passes,
 * rebuilt along with the rest of the query.
 */
function soundcloud(url: URL): string | null {
  if (!onHost(url, 'w.soundcloud.com') || !SOUNDCLOUD_PATH.test(url.pathname)) return null
  const target = httpUrl(url.searchParams.get('url') ?? '')
  if (!target || target.protocol !== 'https:' || !onHost(target, 'api.soundcloud.com')) return null
  if (target.search || target.hash) return null
  const m = SOUNDCLOUD_TARGET.exec(target.pathname)
  if (!m || (m[2] !== undefined && m[2] !== m[1])) return null
  const what = encodeURIComponent(`https://api.soundcloud.com/${m[1]}/${m[3]}`)
  return `${FRAMES.soundcloud[0]}?url=${what}&auto_play=false`
}

function miro(url: URL): string | null {
  if (!onHost(url, 'miro.com')) return null
  const m = MIRO_PATH.exec(url.pathname.replace(/%3D/gi, '='))
  return m ? `${FRAMES.miro[0]}${m[1]}/` : null
}

/**
 * The player URL for a provider's link, rebuilt from the ids it names, by
 * provider: links someone shares and the players' own URLs alike. Nothing of
 * the link's query passes unless checked, and frameFor checks the result again.
 */
const CONVERTERS: Record<FrameProvider, (url: URL) => string | null> = {
  youtube,
  vimeo,
  loom,
  figma,
  codepen,
  stackblitz,
  observable,
  spotify,
  soundcloud,
  miro,
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
  for (const convert of Object.values(CONVERTERS)) {
    const player = frame(convert(url))
    if (player) return player
  }
  if (isVideoFile(url)) return { kind: 'video', src: url.href }
  // Only FRAME_SOURCES are framed as they are; a player URL that no converter
  // took stays a link, as it does without frame sources.
  const f = frameFor(url.href, custom)
  return f?.provider === 'custom' ? { kind: 'frame', ...f } : null
}
