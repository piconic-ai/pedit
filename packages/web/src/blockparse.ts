import {
  type Block,
  type Def,
  digestOfReferences,
  parseSegment,
  type References,
  referencesOf,
} from './preview.ts'

/** What BlockParser.update found: the document's blocks and which of them are new. */
export interface Parsed {
  /** The document's blocks. The parser owns the array and the blocks: read only. */
  blocks: Block[]
  references: References
  /** A digest that changes when the definitions do (see keyOf). */
  refs: string
  /**
   * Blocks [from, to) are new. They replace the last update's blocks [from, oldTo);
   * the ones before are as they were, the ones after are as they were but for
   * their lines, which moved by `lineShift` (the very objects: updated in place).
   */
  from: number
  oldTo: number
  to: number
  lineShift: number
}

// Cut candidates tried on each side, and windows tried, before parsing everything.
const CUTS = 200
const WINDOWS = 4
const OPENER = /^﻿?---[\t ]*(?:\r\n?|\n|$)/

/**
 * Parses a document into blocks (see parseBlocks), and when the text then changes a
 * little, parses only the part around the change and keeps the blocks around it.
 *
 * The window is cut where a block parse starts afresh, so that parsing it alone gives
 * the blocks a parse of everything would: a line that starts a top-level block, after
 * a blank line, with no indent and no first character that could join a list or open
 * the frontmatter. The left cut is a line of the old text above the change where a
 * block started, so the parse up to it, which is of the text above, is the same. The
 * right cut is a line of the text below the change that is such a line in the new text
 * too; the window then ends with a blank line and what follows it cannot continue
 * anything in it, but an open fence or frontmatter, which `unclosed` looks for.
 * Anything else the parser is unsure of is a full parse: the result is always the
 * one parseBlocks gives.
 */
export class BlockParser {
  #windowAbove: number
  #source: string | undefined
  #blocks: Block[] = []
  // The reference definitions with their lines, in order: a definition far from an
  // edit can only be dropped by a later duplicate if the duplicate is kept too.
  #defs: Def[] = []
  #references: References = {}
  #refs = digestOfReferences({})

  /** Texts shorter than `windowAbove` characters are always parsed whole. */
  constructor(windowAbove = 20_000) {
    this.#windowAbove = windowAbove
  }

  reset(): void {
    this.#source = undefined
    this.#blocks = []
    this.#defs = []
  }

  update(source: string): Parsed {
    const before = this.#source
    if (before === source) return this.#result(0, 0, 0, 0)
    this.#source = source
    const windowed =
      before !== undefined && Math.max(before.length, source.length) >= this.#windowAbove
        ? this.#parseWindow(before, source)
        : null
    return windowed ?? this.#parseAll(source)
  }

  #result(from: number, oldTo: number, to: number, lineShift: number): Parsed {
    return {
      blocks: this.#blocks,
      references: this.#references,
      refs: this.#refs,
      from,
      oldTo,
      to,
      lineShift,
    }
  }

  #parseAll(source: string): Parsed {
    const old = this.#blocks.length
    this.#defs = []
    this.#blocks = parseSegment(source, 0, 0, this.#defs)
    this.#setReferences()
    return this.#result(0, old, this.#blocks.length, 0)
  }

  #setReferences(): void {
    this.#references = referencesOf(this.#defs)
    this.#refs = digestOfReferences(this.#references)
  }

  // The update as a window, or null when it is not safe or not worth it.
  #parseWindow(before: string, source: string): Parsed | null {
    const blocks = this.#blocks
    const prefix = commonPrefix(before, source)
    const tail = before.length - commonSuffix(before, source, prefix)
    const from = this.#leftCut(before, prefix)
    // A document that may open with frontmatter can gain its closing line anywhere.
    if (from > 0 && OPENER.test(before) && blocks[0]?.tokens[0]?.type !== 'frontmatter') return null
    const move = source.length - before.length
    const start = from === 0 ? 0 : (blocks[from] as Block).offset
    const line0 = from === 0 ? 0 : (blocks[from] as Block).line
    let end = at(blocks, tail, (b) => b.offset)
    for (let tries = 0; tries < WINDOWS; tries++) {
      end = this.#rightCut(source, end, move)
      const stop = blocks[end] ? (blocks[end] as Block).offset + move : source.length
      if (stop - start > source.length / 2) return null
      const text = source.slice(start, stop)
      const defs: Def[] = []
      const fresh = parseSegment(text, line0, start, defs)
      if (!blocks[end] || !unclosed(fresh, text)) {
        return this.#splice(from, end, { fresh, defs, text, line0, move })
      }
      end++
    }
    return null
  }

  // Index of the block the window starts at: one a safe distance above the change, or 0.
  #leftCut(before: string, prefix: number): number {
    const blocks = this.#blocks
    let k = at(blocks, prefix + 1, (b) => b.offset) - 1
    for (let tries = 0; k > 0 && tries < CUTS; k--, tries++) {
      const b = blocks[k] as Block
      // Its first line, and a character past it, are above the change.
      const line = b.src.search(/[\r\n]/)
      const lineEnd = b.offset + (line < 0 ? b.src.length : line)
      if (lineEnd + 2 <= prefix && safeStart(before, b.offset)) return k
    }
    return 0
  }

  // Index of the first block from `k` on that starts at a safe line of the new text.
  #rightCut(source: string, from: number, move: number): number {
    const blocks = this.#blocks
    let k = from
    for (let tries = 0; k < blocks.length && tries < CUTS; k++, tries++) {
      if (safeStart(source, (blocks[k] as Block).offset + move)) return k
    }
    return blocks.length
  }

  #splice(
    from: number,
    end: number,
    w: { fresh: Block[]; defs: Def[]; text: string; line0: number; move: number },
  ): Parsed {
    const { fresh, defs, line0, move } = w
    const oldEnd = this.#blocks[end]?.line ?? Number.POSITIVE_INFINITY
    const lines = end < this.#blocks.length ? line0 + countLines(w.text) - oldEnd : 0
    const a = at(this.#defs, line0, (d) => d.line)
    const z = at(this.#defs, oldEnd, (d) => d.line)
    this.#blocks = replaceRange(this.#blocks, from, end, fresh)
    this.#defs = replaceRange(this.#defs, a, z, defs)
    if (lines !== 0 || move !== 0) {
      for (let i = from + fresh.length; i < this.#blocks.length; i++) {
        const b = this.#blocks[i] as Block
        b.line += lines
        b.lineEnd += lines
        b.offset += move
      }
      for (let i = a + defs.length; i < this.#defs.length; i++) (this.#defs[i] as Def).line += lines
    }
    if (z > a || defs.length > 0) this.#setReferences()
    return this.#result(from, end, from + fresh.length, lines)
  }
}

// `items` with [from, end) replaced by `fresh`, in place unless that is a lot of items.
export function replaceRange<T>(items: T[], from: number, end: number, fresh: T[]): T[] {
  if (fresh.length < 5000) {
    items.splice(from, end - from, ...fresh)
    return items
  }
  return items.slice(0, from).concat(fresh, items.slice(end))
}

// The first index whose value is at least `value`, of items sorted by it.
function at<T>(items: T[], value: number, by: (item: T) => number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (by(items[mid] as T) < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

const countLines = (text: string): number => text.match(/\r\n?|\n/g)?.length ?? 0

const CHUNK = 1024

/** Length of the common start of two strings: native compares of chunks, then characters. */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i + CHUNK <= n && a.startsWith(b.substring(i, i + CHUNK), i)) i += CHUNK
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

/** Length of the common end of two strings, not reaching into the first `prefix` characters. */
function commonSuffix(a: string, b: string, prefix: number): number {
  const n = Math.min(a.length, b.length) - prefix
  let i = 0
  while (
    i + CHUNK <= n &&
    a.endsWith(b.substring(b.length - i - CHUNK, b.length - i), a.length - i)
  )
    i += CHUNK
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  return i
}

/**
 * Whether a parse can start afresh at the line starting at `pos`: its first character
 * is not blank or one that could continue a list or open the frontmatter, and the
 * line above is blank.
 */
function safeStart(text: string, pos: number): boolean {
  const c = text.charCodeAt(pos)
  // Above a space; not a list marker (- + *) or a digit; not a byte order mark.
  if (!(c > 32) || c === 0xfeff || c === 45 || c === 43 || c === 42 || (c >= 48 && c <= 57))
    return false
  let i = pos - 1
  if (text[i] !== '\n' && text[i] !== '\r') return false
  if (text[i] === '\n' && text[i - 1] === '\r') i--
  i--
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--
  return i < 0 || text[i] === '\n' || text[i] === '\r'
}

/**
 * Whether a window that ends at a safe line may still go on there: it ends in a fence
 * with no closing line, or it opens with frontmatter that has no end in it.
 */
function unclosed(blocks: Block[], text: string): boolean {
  if (OPENER.test(text) && blocks[0]?.tokens[0]?.type !== 'frontmatter') return true
  const last = blocks.at(-1)
  const token = last?.tokens[0]
  if (!last || last.tokens.length !== 1 || token?.type !== 'fence') return false
  const body = last.src.replace(/(?:\r\n?|\n)$/, '')
  const cut = Math.max(body.lastIndexOf('\n'), body.lastIndexOf('\r'))
  const mark = token.markup.charAt(0)
  const closing = new RegExp(`^ {0,3}${mark}{${token.markup.length},}[ \\t]*$`)
  return cut < 0 || !closing.test(body.slice(cut + 1))
}
