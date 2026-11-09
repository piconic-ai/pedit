import type { ImageResolver } from './core/attachments.ts'
import {
  type Block,
  type BlockEnv,
  holdsEmbed,
  keyOf,
  pageMediaSources,
  parseBlocks,
  patchHeldEmbed,
  renderBlock,
} from './preview.ts'

/** A rendered block: its key, its elements and its block as of the last render. */
interface Entry {
  key: string
  block: Block
  elements: Element[]
}

/**
 * Keeps the rendered Markdown of a document in `container`, one top-level block
 * at a time. A block whose key (see keyOf) is the same as in the last render
 * keeps its live elements, with whatever was done to them (a loaded player, a
 * ticked box); only blocks with a new key are rendered. Every root carries its
 * block's first line in the document (`data-line`) and the line after it
 * (`data-line-end`), stamped on every update; the `data-line`s nested in a root
 * count from the root's block (renderBlock), so they never need touching.
 */
export class BlockRenderer {
  #container: Element
  #breaks: boolean
  // The blocks shown, in order.
  #entries: Entry[] = []

  constructor(container: Element, options: { breaks?: boolean } = {}) {
    this.#container = container
    this.#breaks = options.breaks ?? false
  }

  /** Forgets every block, e.g. when the container is about to show another text. */
  reset(): void {
    this.#entries = []
    this.#container.replaceChildren()
  }

  /**
   * Shows `source`, rebuilding only the blocks that changed. Bump `imagesVersion`
   * when the resolver would answer differently for the same text.
   */
  update(
    source: string,
    images?: ImageResolver,
    imagesVersion = 0,
    media: readonly string[] = pageMediaSources(),
  ): void {
    const { blocks, references, refs } = parseBlocks(source)
    const env: BlockEnv = { images, media, breaks: this.#breaks, references }
    const prev = this.#entries
    const n = blocks.length
    const entries: (Entry | undefined)[] = new Array(n)
    const keys: string[] = new Array(n)
    for (let i = 0; i < n; i++) {
      keys[i] = keyOf(blocks[i] as Block, refs, imagesVersion, this.#breaks)
    }

    // Blocks that did not move relative to the ends keep their entry: this is
    // what an edit, or a line inserted, looks like. Matching them by position
    // first keeps identical blocks (a document of repeated sections) from
    // trading elements with each other.
    let head = 0
    while (head < n && head < prev.length && (prev[head] as Entry).key === keys[head]) {
      entries[head] = prev[head]
      head++
    }
    let tail = 0
    while (
      tail < n - head &&
      tail < prev.length - head &&
      (prev[prev.length - 1 - tail] as Entry).key === keys[n - 1 - tail]
    ) {
      entries[n - 1 - tail] = prev[prev.length - 1 - tail]
      tail++
    }

    // In between, a block takes the first unused entry with its key (identical
    // blocks are claimed in order), or is rendered.
    const unused = new Map<string, Entry[]>()
    for (let i = head; i < prev.length - tail; i++) {
      const e = prev[i] as Entry
      const list = unused.get(e.key)
      if (list) list.push(e)
      else unused.set(e.key, [e])
    }
    const missed: number[] = []
    for (let i = head; i < n - tail; i++) {
      const entry = unused.get(keys[i] as string)?.shift()
      if (entry) entries[i] = entry
      else missed.push(i)
    }

    // What is left is gone from the document, unless a block that is new is an
    // edited one holding a loaded embed: that keeps its element.
    let held: Entry[] | undefined
    for (const i of missed) {
      const block = blocks[i] as Block
      const fresh = renderBlock(block, env)
      held ??= [...unused.values()]
        .flat()
        .filter((e) => e.elements.length === 1 && holdsEmbed(e.elements[0] as Element))
      const only = fresh[0]
      let elements = fresh
      if (fresh.length === 1 && only) {
        const at = held.findIndex((e) => patchHeldEmbed(e.elements[0] as Element, only))
        if (at >= 0) elements = (held.splice(at, 1)[0] as Entry).elements
      }
      entries[i] = { key: keys[i] as string, block, elements }
    }

    const list = entries as Entry[]
    const roots: Element[] = []
    for (let i = 0; i < n; i++) {
      const entry = list[i] as Entry
      entry.block = blocks[i] as Block
      for (const el of entry.elements) {
        set(el, 'data-line', String(entry.block.line))
        set(el, 'data-line-end', String(entry.block.lineEnd))
        roots.push(el)
      }
    }
    this.#entries = list
    this.#reconcile(roots)
  }

  // Makes the container's children exactly `roots`, in order, moving as little as
  // possible: a node that stays is never moved, as a frame reloads when it moves.
  #reconcile(roots: Element[]): void {
    const container = this.#container
    const wanted = new Set<Node>(roots)
    let cur = container.firstChild
    for (const el of roots) {
      while (cur && !wanted.has(cur)) {
        const next = cur.nextSibling
        cur.remove()
        cur = next
      }
      if (cur === el) cur = cur.nextSibling
      else if (cur && wanted.has(cur) && el.parentNode === container)
        return this.#reorder(roots, wanted)
      else container.insertBefore(el, cur)
    }
    while (cur) {
      const next = cur.nextSibling
      cur.remove()
      cur = next
    }
  }

  // Some block moved: keep the longest run of blocks already in order, move the rest.
  #reorder(roots: Element[], wanted: Set<Node>): void {
    const container = this.#container
    for (const node of [...container.childNodes]) if (!wanted.has(node)) node.remove()
    const at = new Map<Node, number>()
    let n = 0
    for (let c = container.firstChild; c; c = c.nextSibling) at.set(c, n++)
    const stay = longestRun(roots.map((el) => at.get(el) ?? -1))
    let before: Node | null = null
    for (let i = roots.length - 1; i >= 0; i--) {
      const el = roots[i] as Element
      if (!stay.has(i)) container.insertBefore(el, before)
      before = el
    }
  }
}

// An attribute is only written when it changed.
function set(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

/** Indices of a longest strictly increasing run of `values`, ignoring negatives. */
function longestRun(values: number[]): Set<number> {
  const tails: number[] = [] // index into values of the smallest tail per length
  const prev: number[] = new Array(values.length).fill(-1)
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number
    if (v < 0) continue
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((values[tails[mid] as number] as number) < v) lo = mid + 1
      else hi = mid
    }
    prev[i] = lo > 0 ? (tails[lo - 1] as number) : -1
    tails[lo] = i
  }
  const out = new Set<number>()
  for (let i = tails.at(-1) ?? -1; i >= 0; i = prev[i] as number) out.add(i)
  return out
}
