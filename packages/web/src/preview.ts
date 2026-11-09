import { allowsMedia, MEDIA_META, parseMediaSources } from '@pedit/protocol/csp'
import DOMPurify from 'dompurify'
import MarkdownIt, { type Token } from 'markdown-it'
import { parseDocument } from 'yaml'
import { type ProviderId, providerLabel } from './alwaysload.ts'
import type { ImageResolver } from './core/attachments.ts'
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
  linesAttr,
  providerOf,
  type SnippetSource,
  snippetFor,
} from './embed.ts'
import { fixLink } from './links.ts'
import { failureMessage, fetchSnippet } from './snippet.ts'

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

// The frames this preview rendered, by src. loadEmbed loads only these, so a
// placeholder that reached the page some other way loads nothing.
const rendered = new Map<string, string>()
// The same for snippets, by src and lines (snippetKey).
const renderedSnippets = new Set<string>()

const snippetKey = (src: string | null, lines: string | null) => `${src} ${lines ?? ''}`

// A frame is not loaded until someone asks: nobody in the room should contact a
// third party just because someone wrote its URL in the file. The placeholder
// carries only the frame's src and its box; loadEmbed derives everything else
// from the src again, and the frame fills the same box, so loading it does not
// move the page. "Always load" is a checkbox drawn with a role, since the
// sanitiser drops inputs.
// A snippet's placeholder is the same, with the lines it shows and no box: once
// loaded, it is as tall as its lines (up to a limit). Its status is there, empty,
// from the start, as screen readers announce a change in a live region they know.
function embedHtml(embed: Embed, href: string, line: unknown): string {
  if (embed.kind === 'video') return videoHtml(embed.src, '', line)
  let attributes: string
  let status = ''
  if (embed.kind === 'snippet') {
    status = '<span class="embed-error" role="status"></span>'
    const lines = embed.lines ? linesAttr(embed.lines) : null
    renderedSnippets.add(snippetKey(embed.src, lines))
    attributes =
      ` class="embed embed--snippet"${lineAttr(line)} data-embed-src="${escape(embed.src)}"` +
      (lines ? ` data-embed-lines="${lines}"` : '')
  } else {
    rendered.set(embed.src, embed.src)
    attributes =
      ` class="embed"${lineAttr(line)} data-embed-src="${escape(embed.src)}"` +
      ` style="${boxStyle(embed.box)}"`
  }
  const host = new URL(embed.src).host
  const remember = `<span class="embed-remember" role="checkbox" aria-checked="false" tabindex="0">Always load ${escape(providerLabel(embed.provider))}</span>`
  return (
    `<div${attributes}>` +
    `<span class="embed-provider">${escape(embed.title)}</span>${status}` +
    `<span class="embed-actions"><span class="embed-load" role="button" tabindex="0">Load from ${escape(host)}</span>${remember}</span>` +
    `<a class="embed-link" href="${escape(href)}">${escape(href)}</a></div>`
  )
}

// A paragraph that is nothing but a URL an embed provider takes, or a video file
// URL, becomes a player (a video) or a placeholder that loads one on request (a
// frame, or a snippet of text).
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

// Tag blocks with their first source line, for scroll sync, and the line after
// their last (exclusive), for mapping a selection back to the source.
md.core.ruler.push('source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1 && token.type !== 'inline') {
      token.attrSet('data-line', String(token.map[0]))
      token.attrSet('data-line-end', String(token.map[1]))
    }
  }
})

/** Where a run of an inline token's content starts in the source. */
interface Stamp {
  srcStart: number
  /** A delimiter's text on its own: its place is not known exactly. */
  lone?: boolean
}

// The inline parser tells where each run of text starts in the inline token's
// content: `pending` is when it begins, a pushed token is where it is pushed.
class PosState extends md.inline.State {
  #pending = ''
  #start = 0
  constructor(...args: ConstructorParameters<typeof md.inline.State>) {
    super(...args)
    Object.defineProperty(this, 'pending', {
      configurable: true,
      enumerable: true,
      get: () => this.#pending,
      set: (value: string) => {
        if (value && !this.#pending) this.#start = this.pos
        this.#pending = value
      },
    })
  }
  override pushPending() {
    const start = this.#start
    const token = super.pushPending()
    token.meta = { srcStart: start } satisfies Stamp
    return token
  }
  override push(type: string, tag: string, nesting: 1 | 0 | -1) {
    const token = super.push(type, tag, nesting)
    if (type === 'code_inline') token.meta = { srcStart: this.pos } satisfies Stamp
    else if (type === 'text') token.meta = { srcStart: this.pos, lone: true } satisfies Stamp
    return token
  }
}
md.inline.State = PosState

// As markdown-it's own, but a joined run keeps where it starts, if its parts
// are next to each other.
md.inline.ruler2.at('fragments_join', (state) => {
  const tokens = state.tokens
  let last = 0
  let level = 0
  let curr = 0
  for (; curr < tokens.length; curr++) {
    const token = tokens[curr] as Token
    const next = tokens[curr + 1]
    if (token.nesting < 0) level--
    token.level = level
    if (token.nesting > 0) level++
    if (token.type === 'text' && next?.type === 'text') {
      const a = token.meta as Stamp | null
      const b = next.meta as Stamp | null
      // An emptied delimiter adds nothing.
      const joined = a && b && a.srcStart + token.content.length === b.srcStart
      if (token.content !== '')
        next.meta = joined ? ({ srcStart: a.srcStart } satisfies Stamp) : null
      next.content = token.content + next.content
    } else {
      if (curr !== last) tokens[last] = token
      last++
    }
  }
  if (curr !== last) tokens.length = last
})

/** Maps a run of an inline token's content to the source: the offset, or -1. */
type RunMap = (start: number, length: number) => number

/** A paragraph's or heading's lines: each line of its content is the end of its source line. */
function linesMap(
  src: string,
  starts: number[],
  content: string,
  first: number,
  last: number,
  atx: boolean,
): RunMap | null {
  const lines = content.split('\n')
  if (lines.length !== last - first) return null
  const parts: { from: number; to: number; src: number }[] = []
  let at = 0
  for (const [i, line] of lines.entries()) {
    const text = line.trimEnd()
    const shown = text.trimStart()
    const lead = text.length - shown.length
    const begin = starts[first + i] ?? src.length
    const end = (starts[first + i + 1] ?? src.length + 1) - 1
    const source = src.slice(begin, end).trimEnd()
    if (shown) {
      // markdown-it only takes a line's start (indent, "> ", a marker, "#") and its ends away.
      const prefix = atx && i === 0 ? /^ {0,3}#{1,6}[ \t]*/.exec(source)?.[0].length : undefined
      let from: number
      if (prefix !== undefined && source.startsWith(shown, prefix)) from = begin + prefix
      else if (source.endsWith(shown)) from = begin + source.length - shown.length
      else return null
      parts.push({ from: at + lead, to: at + text.length, src: from })
    }
    at += line.length + 1
  }
  return (start, length) => {
    const part = parts.find((p) => p.from <= start && start + length <= p.to)
    return part ? part.src + (start - part.from) : -1
  }
}

/** The cells of a table row, as markdown-it splits it: where each starts and ends in `row`. */
function cellSpans(row: string): { from: number; to: number }[] {
  const cuts = [-1]
  for (let i = 0, escaped = false; i < row.length; i++) {
    if (row[i] === '|' && !escaped) cuts.push(i)
    escaped = row[i] === '\\'
  }
  cuts.push(row.length)
  const spans = cuts.slice(1).map((end, i) => ({ from: (cuts[i] ?? -1) + 1, to: end }))
  if (spans[0] && spans[0].from === spans[0].to) spans.shift()
  const lastSpan = spans[spans.length - 1]
  if (lastSpan && lastSpan.from === lastSpan.to) spans.pop()
  return spans
}

// Gives each run of visible text its offset in the source (`data-src`), so a
// selection in the page can be mapped back exactly. Positions come from the
// parser, never from searching: a run is mapped only if it is the source as it
// is shown. Entities, escapes, linkified URLs and anything else are left out.
md.core.ruler.before('text_join', 'source_offsets', (state) => {
  const src = state.src
  const starts = [0]
  for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1)
  const at = (line: number) => starts[line] ?? src.length
  const lineEnd = (line: number) => (starts[line + 1] ?? src.length + 1) - 1
  const tokens = state.tokens
  // Maps the runs of one inline token with `map`.
  const mark = (token: Token, map: RunMap | null) => {
    if (!map || !token.children) return
    // The text of a linkified URL or <autolink> is not the source's.
    const autos: boolean[] = []
    for (const child of token.children) {
      const stamp = child.meta as Stamp | null
      if (child.type === 'link_open') autos.push(child.info === 'auto')
      else if (child.type === 'link_close') autos.pop()
      if (autos.includes(true) || !stamp || stamp.lone) continue
      const n = child.content.length
      if (child.type === 'text') {
        if (token.content.slice(stamp.srcStart, stamp.srcStart + n) !== child.content) continue
        const offset = map(stamp.srcStart, n)
        if (offset < 0) continue
        child.type = 'src_text'
        child.meta = { offset }
      } else if (child.type === 'code_inline') {
        // The code between its backticks, as it is: no padding, no line break.
        const from = stamp.srcStart + child.markup.length
        if (token.content.slice(from, from + n) !== child.content) continue
        if (token.content[from + n] !== '`') continue
        const offset = map(from, n)
        if (offset >= 0) child.attrSet('data-src', String(offset))
      }
    }
  }
  let tableLevel = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.type === 'fence' || token.type === 'code_block') {
      if (!token.map || !token.content) continue
      // Whole lines of the source, or one line that ends as the source's does.
      const first = at(token.map[0] + (token.type === 'fence' ? 1 : 0))
      let base = src.startsWith(token.content, first) ? first : -1
      const line = token.content.endsWith('\n') ? token.content.slice(0, -1) : token.content
      if (base < 0 && !line.includes('\n')) {
        const source = src.slice(first, lineEnd(token.map[0] + (token.type === 'fence' ? 1 : 0)))
        if (source.endsWith(line)) base = first + source.length - line.length
      }
      if (base >= 0) token.attrSet('data-src', String(base))
    } else if (token.type === 'table_open') {
      tableLevel = token.level
    } else if (token.type === 'tr_open' && token.map && tableLevel === 0) {
      // A table in a quote or a list has a prefix before its rows: left out.
      const row = src.slice(at(token.map[0]), lineEnd(token.map[0])).trim()
      const base =
        at(token.map[0]) + src.slice(at(token.map[0]), lineEnd(token.map[0])).search(/\S/)
      const spans = cellSpans(row)
      let cell = 0
      for (let j = i + 1; tokens[j] && tokens[j]?.type !== 'tr_close'; j++) {
        const inline = tokens[j] as Token
        if (inline.type !== 'inline') continue
        const span = spans[cell++]
        if (!span) continue
        const raw = row.slice(span.from, span.to)
        const lead = raw.length - raw.trimStart().length
        // A cell with an escaped pipe is not its source: left out.
        if (raw.trim() !== inline.content) continue
        const start = base + span.from + lead
        mark(inline, (s, n) => (s + n <= inline.content.length ? start + s : -1))
      }
    } else if (token.type === 'inline' && token.map) {
      const open = tokens[i - 1]
      const atx = open?.type === 'heading_open' && open.markup.startsWith('#')
      mark(token, linesMap(src, starts, token.content, token.map[0], token.map[1], atx))
    }
  }
})

md.renderer.rules.src_text = (tokens, idx) => {
  const token = tokens[idx]
  return `<span data-src="${(token?.meta as { offset: number }).offset}">${escape(token?.content ?? '')}</span>`
}

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
    // A placeholder may only ever load a frame pedit would frame for that src,
    // or a snippet pedit would fetch for it.
    const src = el.getAttribute('data-embed-src')
    if (isAllowedFrame(src)) el.removeAttribute('data-embed-lines')
    else if (!snippetFor(src, el.getAttribute('data-embed-lines'))) {
      el.remove()
      return
    }
    // Its style may only be a box boxStyle writes, never other CSS.
    if (checkBoxStyle(el.getAttribute('style')) === null) el.removeAttribute('style')
  }
  switch (node.nodeName) {
    case 'A':
      fixLink(el)
      break
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
 * MEDIA_SOURCES. `breaks` makes every line break in the text one in the page,
 * as a canvas card shows its text; a document keeps Markdown's paragraphs.
 */
export function render(
  source: string,
  resolver?: ImageResolver,
  sources: readonly string[] = pageMediaSources(),
  options: { breaks?: boolean } = {},
): DocumentFragment {
  images = resolver
  media = sources
  md.set({ breaks: options.breaks ?? false })
  try {
    return sanitize(md.render(source))
  } finally {
    images = undefined
    media = []
    md.set({ breaks: false })
  }
}

/**
 * Who serves the frame of an embed placeholder, derived from its src alone as
 * loadEmbed does, or null if pedit would not frame it.
 */
export function embedProvider(placeholder: Element): ProviderId | null {
  return providerOf(placeholder.getAttribute('data-embed-src'))
}

// patch() compares blocks by the key noted for them as rendered. Note the keys
// of a placeholder and the blocks it sits in, such as a list item, before it
// changes, so it stays while the paragraph with its URL is unchanged.
function noteKeys(placeholder: Element): void {
  for (let el: Element | null = placeholder; el?.hasAttribute('data-line'); el = el.parentElement) {
    keyOf(el)
  }
}

/** Ticks or clears an embed placeholder's "Always load" box; returns whether it is ticked. */
export function toggleRemember(control: Element): boolean {
  const placeholder = control.closest('[data-embed-src]')
  if (placeholder) noteKeys(placeholder)
  const on = control.getAttribute('aria-checked') !== 'true'
  control.setAttribute('aria-checked', String(on))
  return on
}

/**
 * Loads the frame of an embed placeholder, deriving its provider and attributes
 * from its src alone, and moves focus into it unless `focus` is false. Returns
 * null for a placeholder the preview did not render or whose src pedit would
 * not frame. A snippet placeholder starts loading its text (loadSnippet) and
 * is returned itself.
 */
export function loadEmbed(placeholder: Element, focus = true): HTMLElement | null {
  const src = rendered.get(placeholder.getAttribute('data-embed-src') ?? '') ?? null
  const frame = frameFor(src)
  if (!frame) {
    return loadSnippet(placeholder, focus) ? (placeholder as HTMLElement) : null
  }
  const iframe = placeholder.ownerDocument.createElement('iframe')
  // The sandbox has to be in place before the frame is attached and navigates.
  iframe.setAttribute('sandbox', frame.sandbox)
  if (frame.allow) iframe.setAttribute('allow', frame.allow)
  iframe.setAttribute('referrerpolicy', FRAME_REFERRER_POLICY)
  iframe.title = frame.title
  // The URL frameFor rebuilt, never the attribute's text as it stands.
  iframe.src = frame.src
  noteKeys(placeholder)
  placeholder.replaceChildren(iframe)
  placeholder.classList.add('embed--loaded')
  if (focus) iframe.focus()
  return iframe
}

// What each snippet placeholder is loading now, so a second click waits for it.
const loading = new WeakMap<Element, Promise<boolean>>()

/**
 * Fetches and shows the text of a snippet placeholder, deriving what to fetch
 * from its src and lines alone, and moves focus to it unless `focus` is false.
 * Returns null for a placeholder the preview did not render or whose src pedit
 * would not fetch; otherwise whether the text was shown. The text is only ever
 * set as textContent: nothing in the file is parsed as markup. A placeholder
 * that failed says why and offers to try again.
 */
export function loadSnippet(placeholder: Element, focus = true): Promise<boolean> | null {
  const pending = loading.get(placeholder)
  if (pending) return pending
  const src = placeholder.getAttribute('data-embed-src')
  const lines = placeholder.getAttribute('data-embed-lines')
  if (!renderedSnippets.has(snippetKey(src, lines))) return null
  const snippet = snippetFor(src, lines)
  if (!snippet) return null
  noteKeys(placeholder)
  // Marked loaded from the start, so "Always load" never starts it again.
  placeholder.classList.add('embed--loaded', 'embed--loading')
  placeholder.classList.remove('embed--failed')
  const status = placeholder.querySelector('.embed-error')
  if (status) status.textContent = ''
  const control = placeholder.querySelector('.embed-load')
  if (control) {
    control.textContent = 'Loading…'
    control.setAttribute('aria-disabled', 'true')
  }
  const done = fetchSnippet(snippet.src, snippet.lines).then((result) => {
    loading.delete(placeholder)
    placeholder.classList.remove('embed--loading')
    if (!result.ok) {
      placeholder.classList.add('embed--failed')
      if (status) status.textContent = failureMessage(result)
      if (control) {
        control.textContent = 'Try again'
        control.removeAttribute('aria-disabled')
      }
      return false
    }
    showSnippet(placeholder, snippet, result, focus)
    return true
  })
  loading.set(placeholder, done)
  return done
}

// The lines as text in a <pre>, then a note if lines were left out, and the link
// to the file. Each line is its own element and draws its number before it
// (style.css), so a number stays on its line whatever font the line needs.
function showSnippet(
  placeholder: Element,
  snippet: SnippetSource,
  text: { from: number; lines: string[]; truncated: boolean },
  focus: boolean,
): void {
  const doc = placeholder.ownerDocument
  const pre = doc.createElement('pre')
  pre.className = 'embed-snippet'
  // It scrolls, so it takes focus for the keyboard to scroll it.
  pre.tabIndex = 0
  const last = text.from + text.lines.length - 1
  // A <pre> is generic, which takes no label; a group does.
  pre.setAttribute('role', 'group')
  pre.setAttribute('aria-label', `${snippet.title}, lines ${text.from} to ${last}`)
  // The numbers are as wide as the last one, so every line starts in one column.
  pre.style.setProperty('--snippet-digits', String(String(last).length))
  const code = doc.createElement('code')
  code.append(
    ...text.lines.map((line, i) => {
      const span = doc.createElement('span')
      span.className = 'embed-snippet-line'
      span.setAttribute('data-n', String(text.from + i))
      span.textContent = i < text.lines.length - 1 ? `${line}\n` : line
      return span
    }),
  )
  pre.append(code)
  const parts: Node[] = [pre]
  if (text.truncated) {
    const note = doc.createElement('span')
    note.className = 'embed-note'
    note.textContent = `Showing the first ${text.lines.length} lines.`
    parts.push(note)
  }
  const link = placeholder.querySelector('.embed-link')
  if (link) parts.push(link)
  // Focus was on the control this replaces, if anywhere in the placeholder.
  const active = doc.activeElement
  const had = active === null || active === doc.body || placeholder.contains(active)
  placeholder.replaceChildren(...parts)
  if (focus && had && placeholder.isConnected) pre.focus()
}

const keys = new WeakMap<Node, string>()

// Positions in the source, which shift on every edit: data-src is the offset of a run of text.
const LINE_ATTRS = ['data-line', 'data-line-end', 'data-src']

function copyAttr(name: string, from: Element, to: Element): void {
  const value = from.getAttribute(name)
  if (to.getAttribute(name) === value) return
  if (value === null) to.removeAttribute(name)
  else to.setAttribute(name, value)
}

/** What a top-level node looks like, ignoring the line numbers that shift on every edit. */
function keyOf(node: Node): string {
  let key = keys.get(node)
  if (key === undefined) {
    const clone = node.cloneNode(true)
    if (clone instanceof Element) {
      for (const el of [clone, ...clone.querySelectorAll('[data-line], [data-src]')]) {
        for (const name of LINE_ATTRS) el.removeAttribute(name)
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
    const to = target[i]
    if (to) for (const name of LINE_ATTRS) copyAttr(name, el, to)
  })
}

/** An element's tag and attributes, apart from its line. */
function shellOf(el: Element): string {
  const attributes = [...el.attributes]
    .filter((a) => !LINE_ATTRS.includes(a.name))
    .map((a) => `${a.name}=${a.value}`)
  return [el.tagName, ...attributes].join(' ')
}

/**
 * The embeds under an element that hold something to keep: a loaded player or
 * snippet (also one loading or failed), or a ticked box.
 */
function heldEmbeds(el: Element): Element[] {
  const ticked = [...el.querySelectorAll('.embed-remember[aria-checked="true"]')]
  return [
    ...el.querySelectorAll('.embed--loaded'),
    ...ticked.flatMap((box) => box.closest('[data-embed-src]') ?? []),
  ]
}

/** Whether the fresh element still renders an embed the old one holds, with the same src. */
function keepsEmbed(old: Element, fresh: Element): boolean {
  const held = new Set(heldEmbeds(old).map((el) => el.getAttribute('data-embed-src')))
  if (held.size === 0) return false
  return [...fresh.querySelectorAll('[data-embed-src]')].some((el) =>
    held.has(el.getAttribute('data-embed-src')),
  )
}

/**
 * How well an old node can stand for a fresh one: 2 when it looks the same,
 * 1 when only its children differ and the fresh one still renders an embed the
 * old one holds, a player or a ticked box (a list whose other item changed), so
 * its children are patched in turn. A block of the same shape without that
 * embed, such as a new quote above, never takes it. Whitespace between blocks
 * is never matched: it would pull the matching away from the blocks.
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
      for (const name of LINE_ATTRS) copyAttr(name, node as Element, old)
      patchChildren(old, [...node.childNodes])
    }
    next = head + i + 1
  })
  for (const old of before.slice(next, end)) old.remove()
}
