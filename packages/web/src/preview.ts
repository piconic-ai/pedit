import { allowsMedia, MEDIA_META, parseMediaSources } from '@pedit/protocol/csp'
import DOMPurify from 'dompurify'
import type { Env, StateCore, Token } from 'markdown-it'
import MarkdownIt from 'markdown-it'
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
import { installPositions } from './previewpos.ts'
import { failureMessage, fetchSnippet } from './snippet.ts'

// Raw HTML in the document is shown as text, never parsed.
const md = new MarkdownIt({ html: false, linkify: true })
const escape = md.utils.escapeHtml
// Source positions, for a render that asks for them (BlockEnv.spans); see previewpos.ts.
const positions = installPositions(md)

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
 * Renders a whole document to sanitised nodes in one go: the reference BlockRenderer's
 * blocks add up to, and what its tests compare with. `resolver`
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

// ---------------------------------------------------------------------------
// Per-block pipeline. markdown-it's block parse decides where the top-level
// blocks are (it has to see the whole document); everything after it (inline
// parse, linkify, embeds, source_lines, the renderer, the sanitiser) is a pure
// function of one block's tokens plus the references, the image resolver and the
// `breaks` option, so it can run for one block at a time and be cached by
// `keyOf` (BlockRenderer).
//
// Lines: `Block.line`/`lineEnd`/`offset` are absolute. Every `data-line` that
// renderBlock produces, on the roots and nested, is relative to the block's first
// line (the root of a block has data-line="0"); add `block.line` to get the
// document line. Relative lines do not change when lines are inserted above, so
// they are part of the cached element's identity, not of its key.
// ---------------------------------------------------------------------------

/** One top-level block: its block-level tokens, before the inline parse. */
export interface Block {
  /** Block-level tokens; inline tokens have no children yet. `map` is block-relative. */
  tokens: Token[]
  /** First source line (absolute). */
  line: number
  /** The line after the block's last (absolute). */
  lineEnd: number
  /** Offset of `line` in the original text. */
  offset: number
  /** The block's own lines, from the original (not line-ending-normalised) text. */
  src: string
  /**
   * Whether `src` holds `\r` or `\0`. markdown-it rewrites them before parsing, which
   * shifts offsets; a position map must leave such a block unmapped.
   */
  unmapped: boolean
}

/** What renderBlock needs besides the block, as render() takes it. */
export type References = NonNullable<Env['references']>

export interface BlockEnv {
  images?: ImageResolver
  media: readonly string[]
  breaks: boolean
  /**
   * Wrap each run of text in `<span data-src>` (and mark code) with its offset in
   * `block.src`. Meant for a detached twin of a block, never for the live preview;
   * a block with `unmapped` gets none. Off, the output is exactly as without it.
   */
  spans?: boolean
  /** markdown-it's env.references, as parseBlocks returns it. */
  references: References
}

export interface ParsedBlocks {
  blocks: Block[]
  /** The reference definitions the block parse found. */
  references: References
  /** A short digest that changes when the definitions do; pass it to keyOf. */
  refs: string
}

type CoreRule = (state: StateCore) => void

let afterBlock: CoreRule[] | undefined
let blockOnly: CoreRule[] | undefined

// The core rules by phase, in the chain's order (ours included), looked up once.
function coreRules(): { block: CoreRule[]; rest: CoreRule[] } {
  if (!afterBlock || !blockOnly) {
    const rules = md.core.ruler.__rules__.filter((r) => r.enabled)
    const at = rules.findIndex((r) => r.name === 'block')
    // strip_references drops the definitions' placeholder tokens, so no block is
    // made of one; it belongs to the document-wide phase.
    const early = (r: { name: string }, i: number) => i <= at || r.name === 'strip_references'
    blockOnly = rules.filter(early).map((r) => r.fn)
    afterBlock = rules.filter((r, i) => !early(r, i)).map((r) => r.fn)
  }
  return { block: blockOnly, rest: afterBlock }
}

/** A reference definition found by the block parse, with the line it starts on. */
export interface Def {
  label: string
  ref: unknown
  line: number
}

// Where the reference rule below reports the definitions it parses, while a block
// parse that wants them runs. A window's definitions cannot be told apart from the
// rest in env.references (the first one of a label wins, a later one is dropped), so
// they are kept one by one, with their lines, to put env.references together again.
let defSink: Def[] | undefined

const referenceRule = md.block.ruler.__rules__.find((r) => r.name === 'reference')
if (referenceRule) {
  const original = referenceRule.fn
  md.block.ruler.at(
    'reference',
    (state, start, end, silent) => {
      if (!defSink || silent) return original(state, start, end, silent)
      const outer = state.env
      const scratch: Env = {}
      state.env = scratch
      let ok: boolean
      try {
        ok = original(state, start, end, silent)
      } finally {
        state.env = outer
      }
      if (ok) {
        for (const [label, ref] of Object.entries(scratch.references ?? {}))
          defSink.push({ label, ref, line: start })
      }
      return ok
    },
    { alt: referenceRule.alt },
  )
}

/** What markdown-it's env.references is for these definitions, in document order. */
export function referencesOf(defs: readonly Def[]): References {
  const references: References = {}
  for (const d of defs) {
    if (typeof references[d.label] === 'undefined') references[d.label] = d.ref as never
  }
  return references
}

/** The digest of a set of references, as keyOf wants it. */
export const digestOfReferences = (references: References): string =>
  digestOf(JSON.stringify(references))

/**
 * Parses the whole document into top-level blocks without the inline parse.
 * Lines between blocks (blank lines, reference definitions) belong to no block.
 */
export function parseBlocks(source: string): ParsedBlocks {
  const defs: Def[] = []
  const blocks = parseSegment(source, 0, 0, defs)
  const references = referencesOf(defs)
  return { blocks, references, refs: digestOfReferences(references) }
}

/**
 * The block parse of `source`, which is a part of a document that starts at line
 * `line0`, offset `offset0` (a part that starts where a block does and where nothing
 * before it can reach in). Blocks come with absolute lines and offsets; `defs`
 * receives the reference definitions with absolute lines.
 */
export function parseSegment(source: string, line0: number, offset0: number, defs: Def[]): Block[] {
  const state = new md.core.State(source, md, {})
  const known = defs.length
  defSink = defs
  try {
    for (const rule of coreRules().block) rule(state)
  } finally {
    defSink = undefined
  }
  for (let i = known; i < defs.length; i++) (defs[i] as Def).line += line0
  // Line starts in the original text; markdown-it's newline is \r\n, \r or \n.
  const starts = [0]
  for (const m of source.matchAll(/\r\n?|\n/g)) starts.push(m.index + m[0].length)
  const blocks: Block[] = []
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; ) {
    const first = tokens[i] as Token
    let end = i + 1
    if (first.nesting === 1) {
      while (
        end < tokens.length &&
        !((tokens[end] as Token).level === 0 && (tokens[end] as Token).nesting === -1)
      )
        end++
      end++
    }
    const [line, lineEnd] = first.map ?? [0, 0]
    // These tokens are ours (the document's state is discarded), so shift in place.
    const own = tokens.slice(i, end)
    for (const t of own) if (t.map) t.map = [t.map[0] - line, t.map[1] - line]
    const at = starts[line] ?? source.length
    const text = source.slice(at, starts[lineEnd] ?? source.length)
    blocks.push({
      tokens: own,
      line: line0 + line,
      lineEnd: line0 + lineEnd,
      offset: offset0 + at,
      src: text,
      unmapped: /[\r\0]/.test(text),
    })
    i = end
  }
  return blocks
}

function copyToken(state: StateCore, t: Token): Token {
  const c = new state.Token(t.type, t.tag, t.nesting)
  if (t.attrs) c.attrs = t.attrs.map(([k, v]) => [k, v])
  c.map = t.map ? [t.map[0], t.map[1]] : null
  c.level = t.level
  c.content = t.content
  c.markup = t.markup
  c.info = t.info
  c.meta = t.meta
  c.block = t.block
  c.hidden = t.hidden
  // The block rule leaves an empty list for the inline rule to fill.
  if (t.type === 'inline') c.children = []
  return c
}

/**
 * Inline parse, the remaining core rules, the renderer and the sanitiser, for one
 * block. Returns its top-level elements (usually one), with block-relative lines.
 */
export function renderBlock(block: Block, env: BlockEnv): Element[] {
  images = env.images
  media = env.media
  md.set({ breaks: env.breaks })
  const spans = env.spans === true && !block.unmapped
  if (spans) positions.on()
  try {
    const mdEnv = spans ? { references: env.references, spans } : { references: env.references }
    const state = new md.core.State(block.src, md, mdEnv)
    // Fresh copies: the inline rule and source_lines mutate tokens.
    state.tokens = block.tokens.map((t) => copyToken(state, t))
    for (const rule of coreRules().rest) rule(state)
    return [...sanitize(md.renderer.render(state.tokens, md.options, mdEnv)).children]
  } finally {
    if (spans) positions.off()
    images = undefined
    media = []
    md.set({ breaks: false })
  }
}

// Two 32-bit FNV-1a style hashes run together (different bases and multipliers),
// 64 bits in all, over strings and numbers, with no string building. Module-level
// state, not an object per key: this runs for every block on every render.
let ha = 0
let hb = 0

function hnum(n: number): void {
  ha = Math.imul(ha ^ n, 0x01000193)
  hb = Math.imul(hb ^ n, 0x85ebca6b) ^ (hb >>> 15)
}

function hstr(s: string): void {
  // The length first, so no two field lists feed alike.
  const n = s.length
  hnum(n)
  let a = ha
  let b = hb
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x85ebca6b) ^ (b >>> 15)
  }
  ha = a
  hb = b
}

function digestOf(s: string): string {
  ha = 0x811c9dc5
  hb = 0x9747b28c
  hstr(s)
  return hashDigest()
}

function hashDigest(): string {
  return `${(ha >>> 0).toString(36)}.${(hb >>> 0).toString(36)}`
}

/**
 * What decides how a block renders, exactly: the block's original `src` plus a
 * hash of everything else the output (and anything a later step caches from it)
 * depends on: every block-level token field including its block-relative `map`
 * (nested data-line and embed lines come from it; a frontmatter block is its own
 * token type, so it never equals the same text later), the references (when some text has a `[`), the images'
 * state (`![`) and `breaks`. Equal keys mean equal output, and a hash collision
 * can only matter between blocks with identical source. `refs` is the digest
 * parseBlocks returns.
 */
export function keyOf(block: Block, refs: string, imagesVersion: number, breaks: boolean): string {
  ha = 0x811c9dc5
  hb = 0x9747b28c
  hnum(breaks ? 1 : 0)
  // Token content is not hashed: it is a function of `src` (which the key holds in
  // full) and of the structure hashed here, so equal keys cannot differ in content.
  // Content only ever has a `[` or `![` that src has, so src decides the two
  // dependencies below (conservatively).
  const links = block.src.includes('[')
  const image = links && block.src.includes('![')
  for (const t of block.tokens) {
    hstr(t.type)
    hstr(t.tag)
    hstr(t.markup)
    hstr(t.info)
    hnum(t.nesting)
    hnum(t.level)
    hnum((t.hidden ? 1 : 0) | (t.block ? 2 : 0))
    if (t.map) {
      hnum(t.map[0] + 1)
      hnum(t.map[1] + 1)
    } else hnum(0)
    if (t.attrs) {
      for (const [k, v] of t.attrs) {
        hstr(k)
        hstr(String(v))
      }
    }
    hnum(-1)
  }
  if (links) hstr(refs)
  if (image) hnum(imagesVersion)
  return `${hashDigest()}:${block.src}`
}

/**
 * Who serves the frame of an embed placeholder, derived from its src alone as
 * loadEmbed does, or null if pedit would not frame it.
 */
export function embedProvider(placeholder: Element): ProviderId | null {
  return providerOf(placeholder.getAttribute('data-embed-src'))
}

// BlockRenderer compares blocks by the key noted for them as rendered. Note the keys
// of a placeholder and the blocks it sits in, such as a list item, before it
// changes, so it stays while the paragraph with its URL is unchanged.
function noteKeys(placeholder: Element): void {
  for (let el: Element | null = placeholder; el?.hasAttribute('data-line'); el = el.parentElement) {
    domKey(el)
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

/** What a top-level node looks like, ignoring the line numbers that shift on every edit. */
function domKey(node: Node): string {
  let key = keys.get(node)
  if (key === undefined) {
    const clone = node.cloneNode(true)
    if (clone instanceof Element) {
      for (const el of [clone, ...clone.querySelectorAll('[data-line]')]) {
        el.removeAttribute('data-line')
      }
      // BlockRenderer's stamp on a root.
      clone.removeAttribute('data-line-end')
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
    .filter((a) => a.name !== 'data-line' && a.name !== 'data-line-end')
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

/** What an element looks like as rendered, ignoring line attributes; see domKey. */
export function renderedKey(el: Element): string {
  return domKey(el)
}

/** Copies the (nested) `data-line`s of `from` onto `to`, an element that looks the same. */
export function copyRenderedLines(from: Element, to: Element): void {
  copyLines(from, to)
}

/** Whether the element holds a loaded player or snippet, or a ticked "Always load" box. */
export function holdsEmbed(el: Element): boolean {
  // The element may be the placeholder itself, a paragraph that is only an embed.
  return el.classList.contains('embed--loaded') || heldEmbeds(el).length > 0
}

/**
 * When `fresh` is the same block as `old` with some other part changed (a list
 * whose other item was edited) and still renders an embed `old` holds, patches
 * `old`'s children to match and returns true, so a loaded player stays where it
 * is; so does an `old` that looks as it did when rendered, apart from the player.
 * Otherwise leaves both alone and returns false.
 */
export function patchHeldEmbed(old: Element, fresh: Element): boolean {
  // Looks as it did when it was rendered (a key noted before its player loaded): keep it.
  if (domKey(old) === domKey(fresh)) {
    copyLines(fresh, old)
    return true
  }
  if (shellOf(old) !== shellOf(fresh) || !keepsEmbed(old, fresh)) return false
  // The old element now stands for the fresh one: note its key first, as patching
  // takes the fresh one's children (else a later edit back would find a stale key).
  keys.set(old, domKey(fresh))
  patchChildren(old, [...fresh.childNodes])
  return true
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
  if (domKey(old) === domKey(fresh)) return 2
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

/** Makes `container`'s children those of `after`, keeping old ones that stand for fresh ones. */
function patchChildren(container: Node, after: Node[]): void {
  const before = [...container.childNodes]
  const same = (a: Node | undefined, b: Node | undefined) =>
    a !== undefined && b !== undefined && domKey(a) === domKey(b)
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
      keys.set(old, domKey(node))
      const line = (node as Element).getAttribute('data-line')
      if (line === null) old.removeAttribute('data-line')
      else old.setAttribute('data-line', line)
      patchChildren(old, [...node.childNodes])
    }
    next = head + i + 1
  })
  for (const old of before.slice(next, end)) old.remove()
}
