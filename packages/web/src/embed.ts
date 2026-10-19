import { framedProviders, isSize, isSnippet, PROVIDERS, type ProviderId } from '@pedit/protocol/csp'
import {
  allowOf,
  type FetchProvider,
  type FrameProvider,
  isFetchProvider,
  MAX_LINE,
  type Size,
  type Snippet,
  sandboxOf,
} from '@pedit/protocol/embeds/define'

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

/**
 * The box of an embed. A box with a width in pixels keeps its ratio when the
 * preview is narrower; one without fills the preview's width.
 */
export type Box =
  | { width: number | null; ratio: readonly [number, number] }
  | { width: null; height: number }

/**
 * What pedit decides for a text file it may fetch: the URL to fetch, the lines
 * to show (first and last, from 1; null for the whole file), its provider and
 * the provider's name.
 */
export type SnippetSource = {
  /** The URL to fetch: rebuilt from the parsed src, starting with the provider's fetch prefix. */
  src: string
  lines: readonly [number, number] | null
  provider: ProviderId
  title: string
}

/** A player the preview shows in place of a bare URL or an image. */
export type Embed =
  | ({ kind: 'frame'; box: Box } & Frame)
  | ({ kind: 'snippet' } & SnippetSource)
  | { kind: 'video'; src: string }

// YouTube refuses to play without a referrer; the origin carries no room or key.
export const FRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin'

type Prefix = { provider: ProviderId; frame: string; origin: string; path: string }
type Framing = { ids: ProviderId[]; prefixes: Prefix[]; fetches: Prefix[] }

// The registry is fixed at build time, so the answer only depends on the origin.
const framing = new Map<string, Framing>()

const frameProvider = (id: ProviderId) => PROVIDERS[id] as FrameProvider
const fetchProvider = (id: ProviderId) => PROVIDERS[id] as FetchProvider

/**
 * The providers shown on a page at `page`, as the Worker decided for the
 * policy: none whose frames would cover the editor's own origin, where a frame
 * with allow-same-origin could read the key, and none whose fetches would.
 * `prefixes` are the frame prefixes, `fetches` the fetch prefixes.
 */
function framedOn(page: URL): Framing {
  let out = framing.get(page.origin)
  if (!out) {
    const ids = framedProviders(page).framed
    const prefix = (provider: ProviderId, frame: string) => {
      const url = new URL(frame)
      return { provider, frame, origin: url.origin, path: url.pathname }
    }
    const prefixes: Prefix[] = []
    const fetches: Prefix[] = []
    for (const id of ids) {
      const provider = PROVIDERS[id]
      if (isFetchProvider(provider)) fetches.push(...provider.fetches.map((f) => prefix(id, f)))
      else prefixes.push(...provider.frames.map((f) => prefix(id, f)))
    }
    out = { ids, prefixes, fetches }
    framing.set(page.origin, out)
  }
  return out
}

/** The prefix of `prefixes` that `url` is under, compared on the parsed URL. */
function under(prefixes: readonly Prefix[], url: URL): Prefix | undefined {
  // The parsed pathname has its dot segments resolved, unlike the raw string.
  return prefixes.find((p) => url.origin === p.origin && url.pathname.startsWith(p.path))
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
  const known = under(framedOn(page).prefixes, url)
  if (!known) return null
  const provider = frameProvider(known.provider)
  // Never the fragment: it stays in the room, as a size hint or anything else.
  const rebuilt = `${known.frame}${url.pathname.slice(known.path.length)}${url.search}`
  // A provider that builds its player URLs frames only one it would build, as
  // its frames may be wider than its players (CodePen's are all of codepen.io).
  if (
    provider.embed &&
    httpUrl(playerUrl(known.provider, new URL(rebuilt)) ?? '')?.href !== rebuilt
  ) {
    return null
  }
  return {
    src: rebuilt,
    provider: known.provider,
    title: provider.name,
    sandbox: sandboxOf(provider),
    allow: allowOf(provider),
  }
}

export function isAllowedFrame(src: string | null, page?: URL): boolean {
  return frameFor(src, page) !== null
}

/**
 * Who serves a frame `src`, as the "Always load" preference names it (its key
 * in the registry), or null if the preview must not frame it. Like the frame
 * itself, it comes from frameFor.
 */
export function providerOf(src: string | null, page?: URL): ProviderId | null {
  return frameFor(src, page)?.provider ?? snippetFor(src, null, page)?.provider ?? null
}

const LINES_ATTR = /^([1-9]\d{0,6})-([1-9]\d{0,6})$/

/** How a placeholder writes the lines of a snippet: '10-20'. */
export function linesAttr(lines: readonly [number, number]): string {
  return `${lines[0]}-${lines[1]}`
}

/** The lines a placeholder names, or undefined if they are not lines a snippet may have. */
function parseLines(attr: string): [number, number] | undefined {
  const m = LINES_ATTR.exec(attr)
  if (!m) return undefined
  const lines: [number, number] = [Number(m[1]), Number(m[2])]
  return lines[0] <= lines[1] && lines[1] <= MAX_LINE ? lines : undefined
}

/**
 * The provider of a snippet `src` and what pedit fetches for it, or null if the
 * preview must not fetch it on a page at `page`. `lines` is a placeholder's
 * lines attribute ('10-20'), or null for the whole file. Like frameFor, the
 * sanitiser and loading a snippet take everything from here: the src must be
 * under the fetches of a provider shown here, and one that provider would build
 * itself (snippet() answers it unchanged).
 */
export function snippetFor(
  src: string | null,
  lines: string | null,
  page: URL = here(),
): SnippetSource | null {
  if (src === null) return null
  const range = lines === null ? null : parseLines(lines)
  if (range === undefined) return null
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return null
  }
  if (url.username || url.password || ENCODED_SEPARATOR.test(url.pathname)) return null
  if (url.protocol !== 'https:') return null
  const known = under(framedOn(page).fetches, url)
  if (!known) return null
  // Never the fragment, as for frames.
  const rebuilt = `${known.frame}${url.pathname.slice(known.path.length)}${url.search}`
  const built = snippetOf(known.provider, new URL(rebuilt), page)
  if (built?.src !== rebuilt || built.lines !== undefined) return null
  return {
    src: rebuilt,
    lines: range,
    provider: known.provider,
    title: PROVIDERS[known.provider].name,
  }
}

// What a fetch provider makes of a pasted URL: a snippet under its own
// fetches, or null. Its code runs on a copy, and a failure only means it does
// not take the URL.
function snippetOf(provider: ProviderId, url: URL, page: URL): Snippet | null {
  let out: unknown
  try {
    out = fetchProvider(provider).snippet(new URL(url.href))
  } catch {
    return null
  }
  if (!isSnippet(out)) return null
  const src = httpUrl(out.src)
  if (!src || under(framedOn(page).fetches, src)?.provider !== provider) return null
  return out
}

/** A size someone wrote after a URL: `#width=560&height=315`, either may be left out. */
export type SizeHint = { width?: number | '100%'; height?: number }

// Any run of digits: one too long for a number is clamped like any other.
const LENGTH = '(\\d+)'
// Markdown links write '%' as '%25'.
const WIDTH = '(\\d+|100%(?:25)?)'
const HINT = new RegExp(
  `^#(?:width=${WIDTH}(?:&height=${LENGTH})?|height=${LENGTH}(?:&width=${WIDTH})?)$`,
)

/**
 * The size hint in a URL's fragment, or null. Only a fragment that is a hint
 * and nothing else counts; any other fragment is left as it is.
 */
export function sizeHint(url: URL): SizeHint | null {
  const m = HINT.exec(url.hash)
  if (!m) return null
  const width = m[1] ?? m[4]
  const height = m[2] ?? m[3]
  const hint: SizeHint = {}
  if (width !== undefined) hint.width = width.startsWith('100%') ? '100%' : Number(width)
  if (height !== undefined) hint.height = Number(height)
  return hint
}

// Sizes in pixels, and how wide or tall a box may be (width / height).
export const MIN_SIZE = 100
export const MAX_SIZE = 4000
const WIDEST = 4
const TALLEST = 1 / 2

const clampSize = (n: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)))

/** A ratio of whole numbers within WIDEST and TALLEST. */
function clampRatio(width: number, height: number): [number, number] {
  if (width / height > WIDEST) return [WIDEST, 1]
  if (width / height < TALLEST) return [1, 1 / TALLEST]
  return [width, height]
}

/** A height for a box `width` pixels wide, within the sizes and ratios a box may have. */
function heightFor(width: number, height: number): number {
  const low = Math.max(MIN_SIZE, Math.ceil(width / WIDEST))
  const high = Math.min(MAX_SIZE, Math.floor(width / TALLEST))
  return Math.min(high, Math.max(low, clampSize(height)))
}

/** The box for a provider's default `size` and what the hint, if any, overrides. */
export function boxOf(size: Size, hint: SizeHint | null): Box {
  const ratio = 'ratio' in size ? (size.ratio.split('/').map(Number) as [number, number]) : null
  const width = typeof hint?.width === 'number' ? clampSize(hint.width) : null
  const height = hint?.height === undefined ? null : clampSize(hint.height)
  if (width !== null) {
    // A width in pixels keeps its ratio: the one written, or the provider's.
    const h =
      height ?? (ratio ? (width * ratio[1]) / ratio[0] : (size as { height: number }).height)
    return { width, ratio: [width, heightFor(width, h)] }
  }
  if (height !== null) {
    // Only a height: a ratio box gets as wide as that height makes it.
    if (ratio && hint?.width !== '100%') {
      const [w, h] = clampRatio(ratio[0], ratio[1])
      const wide = clampSize((height * w) / h)
      return { width: wide, ratio: [wide, heightFor(wide, height)] }
    }
    return { width: null, height }
  }
  if (ratio) return { width: null, ratio: clampRatio(ratio[0], ratio[1]) }
  return { width: null, height: clampSize((size as { height: number }).height) }
}

/**
 * The style attribute that lays out a box: only CSS custom properties, written
 * from whole numbers, which style.css reads.
 */
export function boxStyle(box: Box): string {
  const props: string[] = []
  if (box.width !== null) props.push(`--embed-w:${box.width}`)
  // The ratio as two numbers, so the CSS can also narrow the box by it.
  if ('ratio' in box) props.push(`--embed-rw:${box.ratio[0]};--embed-rh:${box.ratio[1]}`)
  else props.push(`--embed-h:${box.height}`)
  return props.join(';')
}

const BOX_STYLE =
  /^(?:--embed-w:(\d{1,4});)?(?:--embed-rw:(\d{1,4});--embed-rh:(\d{1,4})|--embed-h:(\d{1,4}))$/

/**
 * The style attribute again if it is one boxStyle could have written, or null.
 * The sanitiser keeps nothing else on an embed.
 */
export function checkBoxStyle(style: string | null): string | null {
  const m = BOX_STYLE.exec(style ?? '')
  if (!m) return null
  const [, w, rw, rh, h] = m.map((v) => (v === undefined ? undefined : Number(v)))
  const inRange = (n: number | undefined) => n === undefined || (n >= MIN_SIZE && n <= MAX_SIZE)
  if (!inRange(w) || !inRange(h)) return null
  if (rw !== undefined && rh !== undefined) {
    if (rw === 0 || rh === 0 || rw / rh > WIDEST || rw / rh < TALLEST) return null
  } else if (w !== undefined) {
    // A width in pixels always comes with a ratio.
    return null
  }
  return style
}

// What the provider makes of a pasted URL. A provider's code runs on a copy, and
// a failure only means it does not take the URL.
function playerUrl(provider: ProviderId, url: URL): string | null {
  const { embed } = frameProvider(provider)
  if (!embed) return url.href
  try {
    const src = embed(new URL(url.href))
    return typeof src === 'string' ? src : null
  } catch {
    return null
  }
}

// The provider's default box for the URL; a size function that fails or answers
// something no provider may give falls back to a 16:9 player.
function defaultSize(provider: ProviderId, url: URL): Size {
  const { size } = frameProvider(provider)
  if (typeof size !== 'function') return size
  try {
    const out: unknown = size(new URL(url.href))
    if (isSize(out)) return out
  } catch {}
  return { ratio: '16/9' }
}

/**
 * What to show for a URL that stands alone in a paragraph, if anything: the
 * player or snippet of the first provider that takes it, a video file, or
 * nothing. A size hint in the URL's fragment sizes the player and never reaches
 * the provider. A snippet has no size hint: it is as tall as its lines, and its
 * provider gets the fragment as written (GitHub names lines there).
 */
export function embedFor(href: string, page: URL = here()): Embed | null {
  const url = httpUrl(href)
  if (!url) return null
  const written = new URL(url.href)
  const hint = sizeHint(url)
  if (hint) url.hash = ''
  for (const provider of framedOn(page).ids) {
    if (isFetchProvider(PROVIDERS[provider])) {
      // A video file plays as a video, as it did before snippets: it is no text.
      if (isVideoFile(url)) continue
      const s = snippetOf(provider, written, page)
      // What snippet() built must be one it would fetch, from its own fetches.
      const known = s && snippetFor(s.src, s.lines ? linesAttr(s.lines) : null, page)
      if (known?.provider === provider) return { kind: 'snippet', ...known }
      continue
    }
    const src = playerUrl(provider, url)
    // What embed() built must still be under that provider's own frames.
    const f = frameFor(src, page)
    if (f?.provider === provider) {
      return { kind: 'frame', box: boxOf(defaultSize(provider, url), hint), ...f }
    }
  }
  if (isVideoFile(url)) return { kind: 'video', src: url.href }
  return null
}
