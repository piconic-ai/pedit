import type { BlockRenderer } from './blockrender.ts'
import type { Block } from './preview.ts'

// Where a selection made in the Markdown preview is in the Markdown text.
//
// The live preview carries no positions. The blocks the selection starts and ends
// in are rendered again with positions (BlockRenderer.twin), and a character of the
// live block is found in the twin by its offset in the block's text. That is only
// done when both texts are the same, character for character. A selection maps to
// the source range from its first to its last non-blank character, or to nothing:
// a range that is not exactly what was selected is never returned.

/** A range of the Markdown text, as offsets. */
export interface SourceRange {
  from: number
  to: number
}

type Selected = Pick<
  Range,
  'collapsed' | 'startContainer' | 'startOffset' | 'endContainer' | 'endOffset' | 'toString'
>

type Renderer = Pick<BlockRenderer, 'blockAt' | 'twin' | 'source'>

/** A point of the selection: a live root and the offset in its text. */
interface Edge {
  root: Element
  offset: number
}

/** A character of a live root: its index in the root's text. */
interface Char {
  root: Element
  index: number
}

/** A run of a twin's text that is the source as shown: text offsets, and where it starts in the block. */
interface Run {
  el: Element
  from: number
  to: number
  src: number
}

/** A live root with its twin, if they have the same text. */
interface View {
  block: Block
  text: string
  runs: Run[]
}

const isHigh = (c: string | undefined) => c !== undefined && c >= '\ud800' && c <= '\udbff'
const isLow = (c: string | undefined) => c !== undefined && c >= '\udc00' && c <= '\udfff'

/**
 * How many characters of `root`'s text come before the point (`node`, `offset`). Counted
 * on the nodes, with no Range: a Range is tracked by the document until it is collected.
 */
function textBefore(root: Element, node: Node, offset: number): number {
  const next = node.childNodes[offset]
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let count = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return count + offset
    // An element's point: the text before its `offset`th child, or all of its own.
    const after = next
      ? next === n || next.contains(n) || Boolean(next.compareDocumentPosition(n) & 4)
      : !node.contains(n) && Boolean(node.compareDocumentPosition(n) & 4)
    if (after) return count
    count += (n as Text).data.length
  }
  return count
}

/**
 * A point between the roots, in the container: a start takes the next root from its
 * start, an end the previous root up to its end (a boundary between blocks, or a
 * select-all). Null when there is no such root.
 */
function betweenRoots(renderer: Renderer, node: Node, offset: number, start: boolean): Edge | null {
  const kids = node.childNodes
  for (let i = start ? offset : offset - 1; i >= 0 && i < kids.length; i += start ? 1 : -1) {
    const kid = kids[i] as Node
    if (kid instanceof Element && renderer.blockAt(kid)?.element === kid) {
      return { root: kid, offset: start ? 0 : (kid.textContent ?? '').length }
    }
  }
  return null
}

function edgeOf(renderer: Renderer, node: Node, offset: number, start: boolean): Edge | null {
  const hit = renderer.blockAt(node)
  if (hit) return { root: hit.element, offset: textBefore(hit.element, node, offset) }
  return node instanceof Element ? betweenRoots(renderer, node, offset, start) : null
}

/** The first (or last) non-blank character of `text` from `from` up to `to`, or -1. */
function scan(text: string, from: number, to: number, forward: boolean): number {
  const s = text.slice(from, to)
  if (forward) {
    const lead = s.length - s.trimStart().length
    return lead === s.length ? -1 : from + lead
  }
  const end = s.trimEnd().length
  return end === 0 ? -1 : from + end - 1
}

/**
 * The first (or last) non-blank character of the selection from `a` to `b`: the
 * boundary is where the characters are, whichever text node it was in.
 */
function edgeChar(a: Edge, b: Edge, forward: boolean): Char | null {
  const stop = forward ? b.root : a.root
  let root: Element | null = forward ? a.root : b.root
  while (root) {
    const text = root.textContent ?? ''
    const index = scan(
      text,
      root === a.root ? a.offset : 0,
      root === b.root ? b.offset : text.length,
      forward,
    )
    if (index >= 0) return { root, index }
    if (root === stop) return null
    root = forward ? root.nextElementSibling : root.previousElementSibling
  }
  return null
}

/** The innermost element with a `data-src` from `node` up to `root` (not a selector: those are cached). */
function runAbove(node: Node, root: Element): Element | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    if (el.hasAttribute('data-src')) return el
    if (el === root) break
  }
  return null
}

/** The runs of a twin root: the parts of its text that carry a source offset. */
function runsOf(twin: Element): Run[] {
  const runs: Run[] = []
  const seen = new Set<Element>()
  const walker = twin.ownerDocument.createTreeWalker(twin, NodeFilter.SHOW_TEXT)
  let at = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const length = (n as Text).data.length
    const el = runAbove(n, twin)
    const src = el ? Number(el.getAttribute('data-src')) : Number.NaN
    const last = runs[runs.length - 1]
    // A run's text is one stretch: a second stretch of the same element is not mapped.
    if (el && last?.el === el) last.to = at + length
    else if (el && Number.isInteger(src) && !seen.has(el))
      runs.push({ el, from: at, to: at + length, src })
    if (el) seen.add(el)
    at += length
  }
  return runs
}

/** The live roots and twins of a selection, made once each. */
class Views {
  #renderer: Renderer
  #source: string
  #views = new Map<Element, View | null>()
  #twins = new Map<Block, Element[] | null>()

  constructor(renderer: Renderer, source: string) {
    this.#renderer = renderer
    this.#source = source
  }

  get(root: Element): View | null {
    if (!this.#views.has(root)) this.#views.set(root, this.#make(root))
    return this.#views.get(root) ?? null
  }

  #make(root: Element): View | null {
    // What the twin's offsets are in is the text the renderer showed: not a newer one.
    if (this.#source !== this.#renderer.source) return null
    const hit = this.#renderer.blockAt(root)
    if (hit?.element !== root) return null
    const { block } = hit
    // The block is where it says in the text, or the render is stale.
    if (this.#source.slice(block.offset, block.offset + block.src.length) !== block.src) return null
    const twin = this.#twinOf(root, block)?.[this.#indexOf(root, block)]
    const text = root.textContent ?? ''
    if (!twin || twin.textContent !== text) return null
    return { block, text, runs: runsOf(twin) }
  }

  // The block's roots are next to each other: which one this is.
  #indexOf(root: Element, block: Block): number {
    let index = 0
    for (let el = root.previousElementSibling; el; el = el.previousElementSibling) {
      if (this.#renderer.blockAt(el)?.block !== block) break
      index++
    }
    return index
  }

  #twinOf(root: Element, block: Block): Element[] | null {
    if (!this.#twins.has(block)) this.#twins.set(block, this.#renderer.twin(root)?.elements ?? null)
    return this.#twins.get(block) ?? null
  }

  /** The offset in the source of the character `at`, if it is shown as the source has it. */
  sourceOf(at: Char): number | null {
    const view = this.get(at.root)
    const run = view?.runs.find((r) => r.from <= at.index && at.index < r.to)
    if (!view || !run) return null
    const offset = view.block.offset + run.src + (at.index - run.from)
    return this.#source[offset] === view.text[at.index] ? offset : null
  }
}

/** Whether the non-blank characters of `text` appear in order in `within`. */
function inOrder(text: string, within: string): boolean {
  let at = 0
  for (const c of text) {
    if (/\s/.test(c)) continue
    at = within.indexOf(c, at) + 1
    if (at === 0) return false
  }
  return true
}

/** A boundary in the middle of a surrogate pair takes the whole character. */
function whole(at: Char, forward: boolean): Char {
  const text = at.root.textContent ?? ''
  const c = text[at.index]
  if (forward && isLow(c) && isHigh(text[at.index - 1])) return { ...at, index: at.index - 1 }
  if (!forward && isHigh(c) && isLow(text[at.index + 1])) return { ...at, index: at.index + 1 }
  return at
}

/**
 * Where the selection `range`, made in the preview `renderer` shows, is in the
 * Markdown `source` (the text it was last updated with): the span from the first to
 * the last non-blank selected character. Null when it cannot be placed exactly:
 * nothing selected, a selection outside the preview, one that starts or ends in text
 * the source does not hold as it is shown (an escape, an entity, a link's address),
 * or in a block that is not what its source renders to (a loaded embed, a render
 * that is out of date).
 */
export function previewSelectionToSource(
  renderer: Renderer,
  range: Selected,
  source: string,
): SourceRange | null {
  if (range.collapsed) return null
  const a = edgeOf(renderer, range.startContainer, range.startOffset, true)
  const b = edgeOf(renderer, range.endContainer, range.endOffset, false)
  // Clamped to roots, the ends may have crossed (both in one gap).
  if (a && b && a.root !== b.root && a.root.compareDocumentPosition(b.root) & 2) return null
  const first = a && b && edgeChar(a, b, true)
  const last = a && b && edgeChar(a, b, false)
  if (!first || !last) return null
  const views = new Views(renderer, source)
  const start = views.sourceOf(whole(first, true))
  const end = views.sourceOf(whole(last, false))
  if (start === null || end === null) return null
  const from = start
  const to = end + 1
  if (to <= from) return null
  return inOrder(range.toString(), source.slice(from, to)) ? { from, to } : null
}
