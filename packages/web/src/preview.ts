import { allowsMedia, MEDIA_META, parseMediaSources } from '@pedit/protocol/csp'
import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { parseDocument } from 'yaml'
import type { ImageResolver } from './attachments.ts'
import {
  type Embed,
  embedFor,
  FRAME_REFERRER_POLICY,
  frameFor,
  httpUrl,
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

function embedHtml(embed: Embed, line: unknown): string {
  if (embed.kind === 'video') return videoHtml(embed.src, '', line)
  const allow = embed.allow ? ` allow="${escape(embed.allow)}"` : ''
  return (
    `<div class="embed"${lineAttr(line)}><iframe src="${escape(embed.src)}" title="${escape(embed.title)}"` +
    ` loading="lazy"${allow} sandbox="${escape(embed.sandbox)}"` +
    ` referrerpolicy="${FRAME_REFERRER_POLICY}"></iframe></div>`
  )
}

// A paragraph that is nothing but a URL an embed provider takes, or a video file
// URL, becomes a player.
md.core.ruler.after('linkify', 'embeds', (state) => {
  const tokens = state.tokens
  for (let i = 0; i + 2 < tokens.length; i++) {
    const [open, inline, close] = [tokens[i], tokens[i + 1], tokens[i + 2]]
    if (open?.type !== 'paragraph_open' || close?.type !== 'paragraph_close' || !inline) continue
    const [linkOpen, text, linkClose, ...rest] = inline.children ?? []
    // info is 'auto' for both linkified URLs and <autolinks>, not for [text](url).
    if (linkOpen?.type !== 'link_open' || linkOpen.info !== 'auto') continue
    if (text?.type !== 'text' || linkClose?.type !== 'link_close' || rest.length > 0) continue
    const embed = embedFor(String(linkOpen.attrGet('href') ?? ''))
    if (!embed) continue
    // A video file the relay would not load stays an ordinary link.
    if (embed.kind === 'video' && !allowed(new URL(embed.src))) continue
    const token = new state.Token('embed', '', 0)
    token.meta = { embed, line: open.map?.[0] }
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
  const { embed, line } = tokens[idx]?.meta as { embed: Embed; line?: number }
  return embedHtml(embed, line)
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

purify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'iframe' && !frameFor((node as Element).getAttribute('src'))) {
    node.parentNode?.removeChild(node)
  }
})

// blob: URLs are not allowed by default; keep the ones for our own images.
purify.addHook('uponSanitizeAttribute', (node, data) => {
  if (node.nodeName === 'IMG' && data.attrName === 'src' && images?.owns(data.attrValue)) {
    data.forceKeepAttr = true
  }
})

purify.addHook('afterSanitizeAttributes', (node) => {
  const el = node as Element
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
    case 'IFRAME': {
      // Whatever the markup says, a frame runs only with what pedit decides for its src.
      const frame = frameFor(el.getAttribute('src'))
      if (!frame) {
        el.remove()
        break
      }
      el.setAttribute('title', frame.title)
      el.setAttribute('loading', 'lazy')
      if (frame.allow) el.setAttribute('allow', frame.allow)
      else el.removeAttribute('allow')
      el.setAttribute('sandbox', frame.sandbox)
      el.setAttribute('referrerpolicy', FRAME_REFERRER_POLICY)
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
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select'],
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['allow', 'sandbox', 'referrerpolicy', 'loading'],
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
 * blocks at the start and end in place so that images and players inside
 * them do not reload while someone types elsewhere.
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
  const anchor = before[before.length - tail] ?? null
  for (const node of before.slice(head, before.length - tail)) node.remove()
  for (const node of after.slice(head, after.length - tail)) {
    keyOf(node)
    container.insertBefore(node, anchor)
  }
}
