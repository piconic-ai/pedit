import {
  allowsMedia,
  coversOrigin,
  FRAME_META,
  MEDIA_META,
  parseFrameSources,
  parseMediaSources,
} from '@pedit/protocol/csp'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { parseDocument } from 'yaml'
import type { ImageResolver } from './attachments.ts'
import {
  type Embed,
  embedFor,
  FRAME_REFERRER_POLICY,
  type FrameSources,
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

let pageFrames: string[] | undefined

/**
 * The extra frame sources this relay allows (FRAME_SOURCES), as the Worker wrote
 * them into the page. Without the tag, with a bad value, or with one that covers
 * the page's own origin, only the built-in players are framed.
 */
export function pageFrameSources(doc?: Document, page = new URL(location.href)): string[] {
  if (!doc && pageFrames) return pageFrames
  const d = doc ?? document
  const content = d.querySelector(`meta[name="${FRAME_META}"]`)?.getAttribute('content') ?? ''
  const parsed = parseFrameSources(content)
  const sources = parsed && !coversOrigin(parsed, page) ? parsed : []
  if (!doc) pageFrames = sources
  return sources
}

// Set for the duration of one render, like images.
let media: readonly string[] = []
let frames: FrameSources | undefined

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
// carries only the frame's src; loadEmbed derives everything else from it again.
function embedHtml(embed: Embed, href: string, line: unknown): string {
  if (embed.kind === 'video') return videoHtml(embed.src, '', line)
  const host = new URL(embed.src).host
  return (
    `<div class="embed embed--${embed.shape}"${lineAttr(line)} data-embed-src="${escape(embed.src)}">` +
    `<span class="embed-provider">${escape(embed.title)}</span>` +
    `<span class="embed-load" role="button" tabindex="0">Load from ${escape(host)}</span>` +
    `<a class="embed-link" href="${escape(href)}">${escape(href)}</a></div>`
  )
}

// A paragraph that is nothing but a YouTube, Vimeo, FRAME_SOURCES or video file URL
// becomes a player (a video) or a placeholder that loads one on request (a frame).
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
    const embed = embedFor(href, frames)
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
  // A placeholder may only ever load a frame pedit would frame for that src.
  if (
    el.hasAttribute?.('data-embed-src') &&
    !isAllowedFrame(el.getAttribute('data-embed-src'), frames)
  ) {
    el.remove()
    return
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
 * finds the images added during the session; `sources` and `frameSources` are
 * the relay's MEDIA_SOURCES and FRAME_SOURCES.
 */
export function render(
  source: string,
  resolver?: ImageResolver,
  sources: readonly string[] = pageMediaSources(),
  frameSources: readonly string[] = pageFrameSources(),
): DocumentFragment {
  images = resolver
  media = sources
  frames = { sources: frameSources, page: new URL(location.href) }
  try {
    return sanitize(md.render(source))
  } finally {
    images = undefined
    media = []
    frames = undefined
  }
}

/**
 * Loads the frame of an embed placeholder, deriving its provider and attributes
 * from its src alone, and moves focus into it. Returns null for a placeholder
 * whose src pedit would not frame. `frameSources` are the relay's FRAME_SOURCES.
 */
export function loadEmbed(
  placeholder: Element,
  frameSources: readonly string[] = pageFrameSources(),
): HTMLIFrameElement | null {
  const src = placeholder.getAttribute('data-embed-src')
  const frame = frameFor(src, { sources: frameSources, page: new URL(location.href) })
  if (src === null || !frame) return null
  const iframe = placeholder.ownerDocument.createElement('iframe')
  // The sandbox has to be in place before the frame is attached and navigates.
  iframe.setAttribute('sandbox', frame.sandbox)
  if (frame.allow) iframe.setAttribute('allow', frame.allow)
  iframe.setAttribute('referrerpolicy', FRAME_REFERRER_POLICY)
  iframe.title = frame.title
  iframe.src = src
  // patch() compares blocks by the key it noted for the placeholder, so the
  // player stays while the paragraph with its URL is unchanged.
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

function copyLines(from: Node | undefined, to: Node): void {
  if (!(from instanceof Element) || !(to instanceof Element)) return
  const source = [from, ...from.querySelectorAll('*')]
  const target = [to, ...to.querySelectorAll('*')]
  source.forEach((el, i) => {
    const line = el.getAttribute('data-line')
    const to = target[i]
    if (!to || to.getAttribute('data-line') === line) return
    if (line === null) to.removeAttribute('data-line')
    else to.setAttribute('data-line', line)
  })
}

/**
 * Replaces the container's children with the fragment's, leaving unchanged
 * blocks in place so that images and players inside them do not reload while
 * someone types elsewhere.
 */
export function patch(container: Element, fragment: DocumentFragment): void {
  const before = [...container.childNodes]
  const after = [...fragment.childNodes]
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
  const remaining = new Map<string, number[]>()
  for (let i = head; i < end; i++) {
    const key = keyOf(before[i] as Node)
    const at = remaining.get(key)
    if (at) at.push(i)
    else remaining.set(key, [i])
  }
  let next = head
  for (const node of after.slice(head, after.length - tail)) {
    const match = remaining.get(keyOf(node))?.find((i) => i >= next)
    if (match === undefined) {
      container.insertBefore(node, next < end ? (before[next] as Node) : anchor)
      continue
    }
    for (const old of before.slice(next, match)) old.remove()
    copyLines(node, before[match] as Node)
    next = match + 1
  }
  for (const old of before.slice(next, end)) old.remove()
}
