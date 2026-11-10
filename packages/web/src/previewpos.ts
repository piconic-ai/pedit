import type MarkdownIt from 'markdown-it'
import type { StateCore, StateInline, Token } from 'markdown-it'

type Md = InstanceType<typeof MarkdownIt>

// Source positions for the rendered preview. They are produced on demand, never
// for the live preview: nothing here runs unless the block's env has `spans` set
// (BlockRenderer.twin does that, for one block, into a detached element). Every
// offset is relative to the source of the block being rendered (`state.src`).
//
// Positions come from the parser, never from searching: a run of text is given an
// offset (`data-src`) only if it is the source exactly as it is shown. Entities,
// escapes, linkified URLs and whatever else is not that are left out.

/** Where a run of an inline token's content starts in the source. */
interface Stamp {
  srcStart: number
  /** A delimiter's text on its own: its place is not known exactly. */
  lone?: boolean
}

/** Maps a run of an inline token's content to the source: the offset, or -1. */
type RunMap = (start: number, length: number) => number

/** What the position rules read from `env`; set by renderBlock. */
export interface SpanEnv {
  spans?: boolean
}

type InlineStateClass = new (...args: ConstructorParameters<Md['inline']['State']>) => StateInline

// The inline parser tells where each run of text starts in the inline token's
// content: `pending` is when it begins, a pushed token is where it is pushed.
function posState(Base: InlineStateClass): InlineStateClass {
  return class PosState extends Base {
    #pending = ''
    #start = 0
    // Where `pos` was when `pending` was last read, until it is written. Every append
    // is `pending += text`: it reads, may advance `pos` (the fallback in markdown-it's
    // tokenize does `pending += src[pos++]`, so `pos` has moved by the time it is
    // written), then writes. The read is where the text begins.
    #readAt = -1
    constructor(...args: ConstructorParameters<InlineStateClass>) {
      super(...args)
      Object.defineProperty(this, 'pending', {
        configurable: true,
        enumerable: true,
        get: () => {
          this.#readAt = this.pos
          return this.#pending
        },
        set: (value: string) => {
          if (value && !this.#pending) this.#start = this.#readAt >= 0 ? this.#readAt : this.pos
          this.#readAt = -1
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
}

// `next` takes over `token`'s text: it starts where `token` does if they are next to
// each other, and nowhere known otherwise.
function mergeInto(token: Token, next: Token): void {
  const a = token.meta as Stamp | null
  const b = next.meta as Stamp | null
  // An emptied delimiter adds nothing.
  const joined = a && b && a.srcStart + token.content.length === b.srcStart
  if (token.content !== '') next.meta = joined ? ({ srcStart: a.srcStart } satisfies Stamp) : null
  next.content = token.content + next.content
}

// As markdown-it's own, but a joined run keeps where it starts, if its parts are
// next to each other.
function joinStamped(state: StateInline): void {
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
      mergeInto(token, next)
    } else {
      if (curr !== last) tokens[last] = token
      last++
    }
  }
  if (curr !== last) tokens.length = last
}

/** The lines of a block's source: where each starts. */
class Lines {
  readonly src: string
  readonly starts = [0]
  constructor(src: string) {
    this.src = src
    for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) this.starts.push(i + 1)
  }
  at(line: number): number {
    return this.starts[line] ?? this.src.length
  }
  /** The end of a line, before its newline. */
  end(line: number): number {
    return (this.starts[line + 1] ?? this.src.length + 1) - 1
  }
}

/** A paragraph's or heading's lines: each line of its content is the end of its source line. */
function linesMap(
  lines: Lines,
  content: string,
  first: number,
  last: number,
  atx: boolean,
): RunMap | null {
  const rows = content.split('\n')
  if (rows.length !== last - first) return null
  const parts: { from: number; to: number; src: number }[] = []
  let at = 0
  for (const [i, row] of rows.entries()) {
    const text = row.trimEnd()
    const shown = text.trimStart()
    const lead = text.length - shown.length
    const begin = lines.at(first + i)
    const source = lines.src.slice(begin, lines.end(first + i)).trimEnd()
    if (shown) {
      // markdown-it only takes a line's start (indent, "> ", a marker, "#") and its ends away.
      const prefix = atx && i === 0 ? /^ {0,3}#{1,6}[ \t]*/.exec(source)?.[0].length : undefined
      let from: number
      if (prefix !== undefined && source.startsWith(shown, prefix)) from = begin + prefix
      else if (source.endsWith(shown)) from = begin + source.length - shown.length
      else return null
      parts.push({ from: at + lead, to: at + text.length, src: from })
    }
    at += row.length + 1
  }
  return (start, length) => {
    const part = parts.find((p) => p.from <= start && start + length <= p.to)
    return part ? part.src + (start - part.from) : -1
  }
}

/** The cells of a table row, as markdown-it splits it: where each starts and ends in `row`. */
export function cellSpans(row: string): { from: number; to: number }[] {
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

// Maps the runs of one inline token with `map`.
function markRuns(token: Token, map: RunMap | null): void {
  if (!map || !token.children) return
  // The text of a linkified URL or <autolink> is not the source's.
  const autos: boolean[] = []
  for (const child of token.children) {
    const stamp = child.meta as Stamp | null
    if (child.type === 'link_open') autos.push(child.info === 'auto')
    else if (child.type === 'link_close') autos.pop()
    if (autos.includes(true) || !stamp || stamp.lone) continue
    if (child.type === 'text') markText(token, child, stamp, map)
    else if (child.type === 'code_inline') markCode(token, child, stamp, map)
  }
}

function markText(token: Token, child: Token, stamp: Stamp, map: RunMap): void {
  const n = child.content.length
  if (token.content.slice(stamp.srcStart, stamp.srcStart + n) !== child.content) return
  const offset = map(stamp.srcStart, n)
  if (offset < 0) return
  child.type = 'src_text'
  child.meta = { offset }
}

// The code between its backticks, as it is: no padding, no line break.
function markCode(token: Token, child: Token, stamp: Stamp, map: RunMap): void {
  const n = child.content.length
  const from = stamp.srcStart + child.markup.length
  if (token.content.slice(from, from + n) !== child.content) return
  if (token.content[from + n] !== '`') return
  const offset = map(from, n)
  if (offset >= 0) child.attrSet('data-src', String(offset))
}

// A code block: whole lines of the source, or one line that ends as the source's does.
// The element's whole text (`content`, newline included) must be the source there, so
// a block that ends without a newline, whose text has one added, is left out.
function markBlockCode(lines: Lines, token: Token): void {
  if (!token.map || !token.content) return
  const row = token.map[0] + (token.type === 'fence' ? 1 : 0)
  const first = lines.at(row)
  let base = lines.src.startsWith(token.content, first) ? first : -1
  const line = token.content.endsWith('\n') ? token.content.slice(0, -1) : token.content
  if (base < 0 && !line.includes('\n')) {
    const source = lines.src.slice(first, lines.end(row))
    if (source.endsWith(line)) base = first + source.length - line.length
  }
  if (base >= 0 && lines.src.startsWith(token.content, base)) {
    token.attrSet('data-src', String(base))
  }
}

// The cells of the row that opens at tokens[i]. Only for a table at the top: one in
// a quote or a list has a prefix before its rows, which is left out.
function markRow(lines: Lines, tokens: Token[], i: number): void {
  const open = tokens[i] as Token
  if (!open.map) return
  const text = lines.src.slice(lines.at(open.map[0]), lines.end(open.map[0]))
  const row = text.trim()
  const base = lines.at(open.map[0]) + text.search(/\S/)
  const spans = cellSpans(row)
  let cell = 0
  for (let j = i + 1; tokens[j] && tokens[j]?.type !== 'tr_close'; j++) {
    const inline = tokens[j] as Token
    if (inline.type !== 'inline') continue
    const span = spans[cell++]
    if (!span) continue
    const raw = row.slice(span.from, span.to)
    // A cell with an escaped pipe is not its source: left out.
    if (raw.trim() !== inline.content) continue
    const start = base + span.from + (raw.length - raw.trimStart().length)
    markRuns(inline, (s, n) => (s + n <= inline.content.length ? start + s : -1))
  }
}

function sourceOffsets(state: StateCore): void {
  if (!(state.env as SpanEnv).spans) return
  const lines = new Lines(state.src)
  const tokens = state.tokens
  let tableLevel = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token
    if (token.type === 'fence' || token.type === 'code_block') markBlockCode(lines, token)
    else if (token.type === 'table_open') tableLevel = token.level
    else if (token.type === 'tr_open' && tableLevel === 0) markRow(lines, tokens, i)
    else if (token.type === 'inline' && token.map) {
      const open = tokens[i - 1]
      const atx = open?.type === 'heading_open' && open.markup.startsWith('#')
      markRuns(token, linesMap(lines, token.content, token.map[0], token.map[1], atx))
    }
  }
}

/** Turns position tracking on and off around one render. */
export interface Positions {
  on(): void
  off(): void
}

/**
 * Adds the position rules to `md`. They do nothing, and cost nothing, until `on()`
 * (the inline parser keeps its own state class) and until the env carries `spans`.
 */
export function installPositions(md: Md): Positions {
  const plain = md.inline.State as InlineStateClass
  const tracking = posState(plain)
  const join = md.inline.ruler2.__rules__.find((r) => r.name === 'fragments_join')?.fn
  md.inline.ruler2.at('fragments_join', (state) => {
    if ((state.env as SpanEnv).spans || !join) joinStamped(state)
    else join(state)
  })
  md.core.ruler.before('text_join', 'source_offsets', sourceOffsets)
  md.renderer.rules.src_text = (tokens, idx) => {
    const token = tokens[idx]
    return `<span data-src="${(token?.meta as { offset: number }).offset}">${md.utils.escapeHtml(token?.content ?? '')}</span>`
  }
  return {
    on: () => {
      md.inline.State = tracking
    },
    off: () => {
      md.inline.State = plain
    },
  }
}
