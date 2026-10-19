import { allowsMedia, MEDIA_META, parseMediaSources } from '@pedit/protocol/csp'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { parseDocument } from 'yaml'
import type { ImageResolver } from './attachments.ts'
import {
  boxStyle,
  checkBoxStyle,
  type Embed,
  embedFor,
  FRAME_REFERRER_POLICY,
  frameFor,
  httpUrl,
  isAllowedFrame,
  isVideoFile,
} from './embed.ts'

// Raw HTML in the document is shown as text, never parsed.
const md = new MarkdownIt({ html: false, linkify: true })
const escape = md.utils.escapeHtml

// Consume the header as a block so all subsequent source maps stay intact.
md.block.ruler.before('hr', 'frontmatter', (state, start, end, silent) => {
  if (start !== 0 || state.parentType !== 'root') return false
  const line = (n: number) => state.src.slice(state.bMarks[n], state.eMarks[n])
  if (!/^\uFEFF?---[\t ]*$/.test(line(start))) return false
  let close = start + 1
  while (close < end && !/^(---|\.\.\.)[\t ]*$/.test(line(close))) close++
  if (close === end) return false
  if (silent) return true
  const token = state.push('frontmatter', 'section', 0)
  token.content = state.src.slice(state.bMarks[start + 1], state.bMarks[close])
  token.map = [start, close + 1]
  state.line = close + 1
  return true
})

function metadataValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `<div class="frontmatter-items">${value.map((item) => `<span class="frontmatter-item">${metadataValue(item)}</span>`).join('')}</div>`
  }
  if (value !== null && typeof value === 'object') {
    return `<dl>${Object.entries(value)
      .map(
        ([key, item]) =>
          `<div class="frontmatter-row"><dt>${escape(key)}</dt><dd>${metadataValue(item)}</dd></div>`,
      )
      .join('')}</dl>`
  }
  return escape(value === null ? 'null' : String(value))
}

md.renderer.rules.frontmatter = (tokens, idx) => {
  const token = tokens[idx]
  if (!token) return ''
  let content: string
  try {
    const document = parseDocument(token.content, { schema: 'core' })
    if (document.errors.length) throw new Error('Invalid frontmatter')
    const value: unknown = document.toJS({ maxAliasCount: 50 })
    content =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? metadataValue(value)
        : `<pre>${escape(token.content)}</pre>`
  } catch {
    // Keep incomplete or invalid YAML readable while the author edits it.
    content = `<pre>${escape(token.content)}</pre>`
  }
  return `<section class="frontmatter" aria-label="Frontmatter"${lineAttr(token.map?.[0])}><div class="frontmatter-label">Frontmatter</div>${content}</section>\n`
}

function lineAttr(line: unknown): string {
  return typeof line === 'number' ? ` data-line="${line}"` : ''
}

let pageSources: string[] | undefined

/**
 * The media sources this relay lets the page load (img-src and media-src), as the
 * Worker wrote them into the page. Without the tag, or with a bad value, nothing
 * external is allowed, like the policy itself.
 */
export function pageMediaSources(doc?: Document): string[] {
  if (!doc && pageSources) return pageSources
  const d = doc ?? document
  const content = d.querySelector(`meta[name="${MEDIA_META}"]`)?.getAttribute('content') ?? ''
  const sources = parseMediaSources(content) ?? []
  if (!doc) pageSources = sources
  return sources
}

// Set for the duration of one render, like images.
let media: readonly string[] = []

const allowed = (url: URL) => allowsMedia(media, url, new URL(location.href))

function blockedHtml(url: URL, src: string, alt: string): string {
  const kind = isVideoFile(url) ? 'video' : 'image'
  return `<span class="missing-image blocked-media blocked-${kind}" title="${escape(src)}">${escape(alt || src)}<span class="blocked-reason">: this relay does not load external ${kind}s</span></span>`
}

function videoHtml(src: string, label: string, line?: unknown): string {
  const aria = label ? ` aria-label="${escape(label)}"` : ''
  return `<video${lineAttr(line)} src="${escape(src)}"${aria} controls preload="metadata" playsinline></video>`
}

// A frame is not loaded until someone asks: nobody in the room should contact a
// third party just because someone wrote its URL in the file. The placeholder
// carries only the frame's src and its box; loadEmbed derives everything else
// from the src again, and the frame fills the same box, so loading it does not
// move the page.
// The frames this preview rendered, by src. loadEmbed loads only these, so a
// placeholder that reached the page some other way loads nothing.
const rendered = new Map<string, string>()

function embedHtml(embed: Embed, href: string, line: unknown): string {
  if (embed.kind === 'video') return videoHtml(embed.src, '', line)
  rendered.set(embed.src, embed.src)
  const host = new URL(embed.src).host
  return (
    `<div class="embed"${lineAttr(line)} data-embed-src="${escape(embed.src)}"` +
    ` style="${boxStyle(embed.box)}">` +
    `<span class="embed-provider">${escape(embed.title)}</span>` +
    `<span class="embed-load" role="button" tabindex="0">Load from ${escape(host)}</span>` +
    `<a class="embed-link" href="${escape(href)}">${escape(href)}</a></div>`
  )
}

// A paragraph that is nothing but a URL an embed provider takes, or a video file
// URL, becomes a player (a video) or a placeholder that loads one on request (a frame).
md.core.ruler.after('linkify', 'embeds', (state) => {
  const tokens = state.tokens
  for (let i = 0; i + 2 < tokens.length; i++) {
    const [open, inline, close] = [tokens[i], tokens[i + 1], tokens[i + 2]]
    if (open?.type !== 'paragraph_open' || close?.type !== 'paragraph_close' || !inline) continue
    const [linkOpen, text, linkClose, ...rest] = inline.children ?? []
    // info is 'auto' for both linkified URLs and <autolinks>, not for [text](url).
    if (linkOpen?.type !== 'link_open' || linkOpen.info !== 'auto') continue
    if (text?.type !== 'text' || linkClose?.type !== 'link_close' || rest.length > 0) continue
    const href = String(linkOpen.attrGet('href') ?? '')
    const embed = embedFor(href)
    if (!embed) continue
    // A video file the relay would not load stays an ordinary link.
    if (embed.kind === 'video' && !allowed(new URL(embed.src))) continue
    const token = new state.Token('embed', '', 0)
    token.meta = { embed, href, line: open.map?.[0] }
    inline.children = [token]
    open.hidden = true
    close.hidden = true
  }
})

// Tag blocks with their first source line, for scroll sync.
md.core.ruler.push('source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1 && token.type !== 'inline') {
      token.attrSet('data-line', String(token.map[0]))
    }
  }
})

md.renderer.rules.embed = (tokens, idx) => {
  const { embed, href, line } = tokens[idx]?.meta as { embed: Embed; href: string; line?: number }
  return embedHtml(embed, href, line)
}

const defaultImage = md.renderer.rules.image
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  if (!token) return ''
  const src = String(token.attrGet('src') ?? '')
  const alt = self.renderInlineAsText(token.children ?? [], options, env)
  const url = httpUrl(src)
  if (!url) {
    // Relative paths point into the host's disk, which the browser cannot
    // reach, unless it is an image someone added in this session.
    const found = images?.lookup(src) ?? null
    if (found === 'loading') {
      return `<span class="loading-image" title="${escape(src)}">${escape(alt || src)}</span>`
    }
    if (found) {
      token.attrSet('src', found.url)
      token.attrSet('title', token.attrGet('title') ?? src)
      return defaultImage
        ? defaultImage(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options)
    }
    return `<span class="missing-image" title="${escape(src)}">${escape(alt || src)}</span>`
  }
  if (!allowed(url)) return blockedHtml(url, src, alt)
  if (isVideoFile(url)) return videoHtml(url.href, alt)
  token.attrSet('loading', 'lazy')
  token.attrSet('referrerpolicy', 'no-referrer')
  return defaultImage
    ? defaultImage(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
}

// Set for the duration of one render; the renderer rules and the sanitizer
// hooks below are module-wide.
let images: ImageResolver | undefined

const purify = DOMPurify(window)

// blob: URLs are not allowed by default; keep the ones for our own images.
purify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.nodeName === 'IMG' && data.attrName === 'src' && images?.owns(data.attrValue)) {
    data.forceKeepAttr = true
  }
})

purify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element
  if (el.hasAttribute?.('data-embed-src')) {
    // A placeholder may only ever load a frame pedit would frame for that src.
    if (!isAllowedFrame(el.getAttribute('data-embed-src'))) {
      el.remove()
      return
    }
    // Its style may only be a box boxStyle writes, never other CSS.
    if (checkBoxStyle(el.getAttribute('style')) === null) el.removeAttribute('style')
  }
  switch (node.nodeName) {
    case 'A': {
      const href = el.getAttribute('href') ?? ''
      if (httpUrl(href) || href.startsWith('mailto:')) {
        // Leaving this page would lose the key in the URL fragment.
        el.setAttribute('target', '_blank')
        el.setAttribute('rel', 'noopener noreferrer')
      } else {
        // Relative and #fragment links cannot resolve here; keep the text.
        el.removeAttribute('href')
        el.removeAttribute('target')
      }
      break
    }
    case 'IMG':
    case 'VIDEO':
      el.removeAttribute('srcset')
      el.removeAttribute('poster')
      {
        const src = el.getAttribute('src') ?? ''
        const ours = node.nodeName === 'IMG' && images?.owns(src)
        const url = httpUrl(src)
        if ((!url && !ours) || (url && !allowed(url))) el.remove()
      }
      break
  }
})

/** Strips anything that could run script or load from somewhere unexpected. */
export function sanitize(html: string): DocumentFragment {
  return purify.sanitize(html, {
    // Markdown only produces plain HTML: no SVG, MathML, styles or forms.
    USE_PROFILES: { html: true },
    // Frames are never rendered, only built by loadEmbed once someone asks for one.
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
    ADD_ATTR: ['referrerpolicy', 'loading'],
    RETURN_DOM_FRAGMENT: true,
  })
}

/**
 * Renders Markdown to sanitised nodes, ready for {@link patch}. `resolver`
 * finds the images added during the session; `sources` are the relay's
 * MEDIA_SOURCES.
 */
export function render(
  source: string,
  resolver?: ImageResolver,
  sources: readonly string[] = pageMediaSources(),
): DocumentFragment {
  images = resolver
  media = sources
  try {
    return sanitize(md.render(source))
  } finally {
    images = undefined
    media = []
  }
}

/**
 * Loads the frame of an embed placeholder, deriving its provider and attributes
 * from its src alone, and moves focus into it. Returns null for a placeholder
 * the preview did not render or whose src pedit would not frame.
 */
export function loadEmbed(placeholder: Element): HTMLIFrameElement | null {
  const src = rendered.get(placeholder.getAttribute('data-embed-src') ?? '') ?? null
  const frame = frameFor(src)
  if (!frame) return null
  const iframe = placeholder.ownerDocument.createElement('iframe')
  // The sandbox has to be in place before the frame is attached and navigates.
  iframe.setAttribute('sandbox', frame.sandbox)
  if (frame.allow) iframe.setAttribute('allow', frame.allow)
  iframe.setAttribute('referrerpolicy', FRAME_REFERRER_POLICY)
  iframe.title = frame.title
  // The URL frameFor rebuilt, never the attribute's text as it stands.
  iframe.src = frame.src
  // patch() compares blocks by the key noted before the player loaded, so the
  // player stays while the paragraph with its URL is unchanged. Note the keys
  // of the blocks it sits in, such as a list item, while they look as rendered.
  for (let el: Element | null = placeholder; el?.hasAttribute('data-line'); el = el.parentElement) {
    keyOf(el)
  }
  placeholder.replaceChildren(iframe)
  placeholder.classList.add('embed--loaded')
  iframe.focus()
  return iframe
}

const keys = new WeakMap<Node, string>()

/** What a top-level node looks like, ignoring the line numbers that shift on every edit. */
function keyOf(node: Node): string {
  let key = keys.get(node)
  if (key === undefined) {
    const clone = node.cloneNode(true)
    if (clone instanceof Element) {
      for (const el of [clone, ...clone.querySelectorAll('[data-line]')]) {
        el.removeAttribute('data-line')
      }
      key = clone.outerHTML
    } else {
      key = `${node.nodeType}:${node.textContent}`
    }
    keys.set(node, key)
  }
  return key
}

/** The element and its descendants, leaving out what a loaded player replaced. */
function elements(root: Element): Element[] {
  const found = [root]
  if (!root.hasAttribute('data-embed-src')) {
    for (const child of root.children) found.push(...elements(child))
  }
  return found
}

function copyLines(from: Node | undefined, to: Node): void {
  if (!(from instanceof Element) || !(to instanceof Element)) return
  // A loaded embed holds a frame where the fresh one has its placeholder, so
  // pair descendants without looking inside embeds.
  const source = elements(from)
  const target = elements(to)
  source.forEach((el, i) => {
    const line = el.getAttribute('data-line')
    const to = target[i]
    if (!to || to.getAttribute('data-line') === line) return
    if (line === null) to.removeAttribute('data-line')
    else to.setAttribute('data-line', line)
  })
}

/** An element's tag and attributes, apart from its line. */
function shellOf(el: Element): string {
  const attributes = [...el.attributes]
    .filter((a) => a.name !== 'data-line')
    .map((a) => `${a.name}=${a.value}`)
  return [el.tagName, ...attributes].join(' ')
}

/** Whether the fresh element still renders an embed the old one loaded, with the same src. */
function keepsEmbed(old: Element, fresh: Element): boolean {
  const held = new Set(
    [...old.querySelectorAll('.embed--loaded')].map((el) => el.getAttribute('data-embed-src')),
  )
  if (held.size === 0) return false
  return [...fresh.querySelectorAll('[data-embed-src]')].some((el) =>
    held.has(el.getAttribute('data-embed-src')),
  )
}

/**
 * How well an old node can stand for a fresh one: 2 when it looks the same,
 * 1 when only its children differ and the fresh one still renders a player the
 * old one loaded (a list whose other item changed), so its children are patched
 * in turn. A block of the same shape without that player, such as a new quote
 * above, never takes it. Whitespace between blocks is never matched: it would
 * pull the matching away from the blocks.
 */
function affinity(old: Node, fresh: Node): number {
  if (old.nodeType === Node.TEXT_NODE && old.textContent?.trim() === '') return 0
  if (keyOf(old) === keyOf(fresh)) return 2
  if (
    old instanceof Element &&
    fresh instanceof Element &&
    shellOf(old) === shellOf(fresh) &&
    keepsEmbed(old, fresh)
  ) {
    return 1
  }
  return 0
}

// Beyond this many comparisons the middle of a patch is rebuilt rather than matched.
const MATCH_LIMIT = 1 << 20

/** Pairs old and fresh nodes in order, keeping as many (and as similar) as possible. */
function match(before: Node[], after: Node[]): Map<number, [number, number]> {
  const pairs = new Map<number, [number, number]>()
  const [n, m] = [before.length, after.length]
  if (n === 0 || m === 0 || n * m > MATCH_LIMIT) return pairs
  const score = new Uint8Array(n * m)
  const at = (i: number, j: number) => i * m + j
  // best[i][j]: the most that before[i..] and after[j..] can keep.
  const best = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = affinity(before[i] as Node, after[j] as Node)
      score[at(i, j)] = s
      const row = best[i] as Uint32Array
      const below = best[i + 1] as Uint32Array
      row[j] = Math.max(
        below[j] as number,
        row[j + 1] as number,
        s ? s + (below[j + 1] as number) : 0,
      )
    }
  }
  let [i, j] = [0, 0]
  while (i < n && j < m) {
    const s = score[at(i, j)] as number
    const here = (best[i] as Uint32Array)[j] as number
    if (s && here === s + ((best[i + 1] as Uint32Array)[j + 1] as number)) {
      pairs.set(j, [i, s])
      i++
      j++
    } else if (here === (best[i + 1] as Uint32Array)[j]) i++
    else j++
  }
  return pairs
}

/**
 * Replaces the container's children with the fragment's, leaving unchanged
 * blocks in place so that images and players inside them do not reload while
 * someone types elsewhere.
 */
export function patch(container: Element, fragment: DocumentFragment): void {
  patchChildren(container, [...fragment.childNodes])
}

function patchChildren(container: Node, after: Node[]): void {
  const before = [...container.childNodes]
  const same = (a: Node | undefined, b: Node | undefined) =>
    a !== undefined && b !== undefined && keyOf(a) === keyOf(b)
  let head = 0
  while (head < before.length && head < after.length && same(before[head], after[head])) head++
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    same(before.at(-1 - tail), after.at(-1 - tail))
  ) {
    tail++
  }
  const kept = [...before.slice(0, head), ...before.slice(before.length - tail)]
  const fresh = [...after.slice(0, head), ...after.slice(after.length - tail)]
  kept.forEach((node, i) => copyLines(fresh[i], node))
  // In between, keep the blocks that are still there in the same order without
  // moving them, such as a player someone loaded: a frame reloads when it moves.
  const end = before.length - tail
  const anchor = before[end] ?? null
  const middle = after.slice(head, after.length - tail)
  const pairs = match(before.slice(head, end), middle)
  let next = head
  middle.forEach((node, j) => {
    const pair = pairs.get(j)
    if (pair === undefined) {
      container.insertBefore(node, next < end ? (before[next] as Node) : anchor)
      return
    }
    const [i, score] = pair
    const old = before[head + i] as Element
    for (const gone of before.slice(next, head + i)) gone.remove()
    if (score === 2) copyLines(node, old)
    else {
      // The old element now stands for the fresh one: note its key first, as
      // patching takes the fresh one's children.
      keys.set(old, keyOf(node))
      const line = (node as Element).getAttribute('data-line')
      if (line === null) old.removeAttribute('data-line')
      else old.setAttribute('data-line', line)
      patchChildren(old, [...node.childNodes])
    }
    next = head + i + 1
  })
  for (const old of before.slice(next, end)) old.remove()
}
