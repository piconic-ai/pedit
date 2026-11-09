import { BlockParser, replaceRange } from './blockparse.ts'
import type { ImageResolver } from './core/attachments.ts'
import {
  type Block,
  type BlockEnv,
  copyRenderedLines,
  holdsEmbed,
  keyOf,
  pageMediaSources,
  patchHeldEmbed,
  renderBlock,
  renderedKey,
} from './preview.ts'

// What a pane needs besides BlockRenderer, so one module is all it loads.
export { embedProvider, loadEmbed, toggleRemember } from './preview.ts'

/** A rendered block: its key, its elements and its block as of the last render. */
interface Entry {
  key: string
  /** The image links this block's render looked up, to say they are still on screen. */
  images: string[]
  block: Block
  elements: Element[]
}

/** A block rendered again with source positions, detached (see BlockRenderer.twin). */
export interface Twin {
  /** The block's roots, as renderBlock gives them with `spans` on; block-relative `data-src`. */
  elements: Element[]
  /** Where the block starts in the text the renderer last showed. */
  offset: number
  block: Block
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
  #decorate: ((root: Element) => void) | undefined
  #parser: BlockParser
  // The blocks shown, in order: one entry per block of the parser.
  #entries: Entry[] = []
  // What the keys were made with; a key is only reused while these are the same.
  #refs = ''
  #imagesVersion = 0
  // The entries that looked an image up.
  #withImages = new Set<Entry>()
  // The entry each root belongs to, for blockAt.
  #byRoot = new WeakMap<Element, Entry>()
  // What the last update rendered with, for twin.
  #env: Pick<BlockEnv, 'images' | 'media' | 'references'> = { media: [], references: {} }

  /**
   * `decorate` is called on every root as it is rendered, before it is compared with
   * the old ones, so what it adds is part of what a block looks like and a kept
   * element, a loaded player in it too, carries it already. A text shorter than
   * `windowAbove` characters is parsed whole on every update (see BlockParser).
   */
  constructor(
    container: Element,
    options: { breaks?: boolean; decorate?: (root: Element) => void; windowAbove?: number } = {},
  ) {
    this.#parser = new BlockParser(options.windowAbove)
    this.#container = container
    this.#breaks = options.breaks ?? false
    this.#decorate = options.decorate
  }

  /** Forgets every block, e.g. when the container is about to show another text. */
  reset(): void {
    this.#entries = []
    this.#withImages.clear()
    this.#parser.reset()
    this.#container.replaceChildren()
  }

  /**
   * Shows `source`, rebuilding only the blocks that changed. Bump `imagesVersion`
   * when the resolver would answer differently for the same text. What is done
   * besides parsing the edited part is proportional to the blocks that changed (and
   * the lines of those below, when the edit moved them).
   */
  update(
    source: string,
    images?: ImageResolver,
    imagesVersion = 0,
    media: readonly string[] = pageMediaSources(),
  ): void {
    try {
      this.#apply(source, images, imagesVersion, media)
    } catch (error) {
      // The parser may be ahead of the entries: start over, so the next update parses
      // and renders everything (the container is put right by its reconcile).
      this.#entries = []
      this.#withImages.clear()
      this.#parser.reset()
      throw error
    }
  }

  /**
   * The block holding `node` (a root or anything inside one) and its root, or null if
   * `node` is not in the rendered text.
   */
  blockAt(node: Node): { element: Element; block: Block } | null {
    let el: Node | null = node
    while (el && el.parentNode !== this.#container) el = el.parentNode
    const entry = el ? this.#byRoot.get(el as Element) : undefined
    return entry ? { element: el as Element, block: entry.block } : null
  }

  /**
   * The block at `at` (its index, or one of its roots) rendered again from its cached
   * tokens with source positions on, into detached elements: the same pipeline as the
   * live block, so its text equals the live text (check it; a block that was patched
   * since, or has `unmapped`, may differ and carries no positions). Positions are
   * offsets in `block.src`; `offset` is where that starts in the text.
   */
  twin(at: number | Element): Twin | null {
    const entry = typeof at === 'number' ? this.#entries[at] : this.#byRoot.get(at)
    if (!entry) return null
    const elements = renderBlock(entry.block, { ...this.#env, breaks: this.#breaks, spans: true })
    if (this.#decorate) for (const root of elements) this.#decorate(root)
    return { elements, offset: entry.block.offset, block: entry.block }
  }

  #apply(
    source: string,
    images: ImageResolver | undefined,
    imagesVersion: number,
    media: readonly string[],
  ): void {
    const parsed = this.#parser.update(source)
    const { blocks, references, refs } = parsed
    let { from, oldTo, to } = parsed
    const stale = this.#entries.length - (oldTo - from) !== blocks.length - (to - from)
    if (stale || refs !== this.#refs || imagesVersion !== this.#imagesVersion) {
      // The keys of the blocks that did not change are not the keys they would get now.
      from = 0
      oldTo = this.#entries.length
      to = blocks.length
    }
    this.#refs = refs
    this.#imagesVersion = imagesVersion
    const env: BlockEnv = { images, media, breaks: this.#breaks, references }
    this.#env = { images, media, references }
    const fresh = blocks.slice(from, to)
    const keys = fresh.map((b) => keyOf(b, refs, imagesVersion, this.#breaks))
    const old = this.#entries.slice(from, oldTo)
    const entries: (Entry | undefined)[] = new Array(fresh.length)
    const unused = claimKept(old, keys, entries)
    renderMissed(fresh, keys, entries, unused, env, this.#decorate)
    const list = entries as Entry[]
    for (const e of old) this.#withImages.delete(e)
    for (const e of list) if (e.images.length) this.#withImages.add(e)
    if (images) for (const e of this.#withImages) for (const src of e.images) images.lookup(src)
    this.#entries = replaceRange(this.#entries, from, oldTo, list)
    const roots = stampFresh(list, fresh)
    for (const e of list) for (const el of e.elements) this.#byRoot.set(el, e)
    const end = from + list.length
    if (parsed.lineShift !== 0)
      for (let i = end; i < this.#entries.length; i++) stamp(this.#entries[i] as Entry)
    this.#reconcile(roots, edgeRoot(this.#entries, from - 1, -1), edgeRoot(this.#entries, end, 1))
  }

  // Makes the children of the container between `after` and `before` (the roots of
  // blocks that did not change, or null for the ends) exactly `roots`, in order,
  // moving as little as possible: a node that stays is never moved, as a frame
  // reloads when it moves.
  #reconcile(roots: Element[], after: Node | null, before: Node | null): void {
    const container = this.#container
    const wanted = new Set<Node>(roots)
    let cur = after ? after.nextSibling : container.firstChild
    for (const el of roots) {
      while (cur && cur !== before && !wanted.has(cur)) {
        const next = cur.nextSibling
        cur.remove()
        cur = next
      }
      if (cur === el) cur = cur.nextSibling
      else if (cur && cur !== before && el.parentNode === container)
        return this.#reorder(roots, wanted, after, before)
      else container.insertBefore(el, cur)
    }
    while (cur && cur !== before) {
      const next = cur.nextSibling
      cur.remove()
      cur = next
    }
  }

  // Some block moved: keep the longest run of blocks already in order, move the rest.
  #reorder(roots: Element[], wanted: Set<Node>, after: Node | null, before: Node | null): void {
    const container = this.#container
    const first = after ? after.nextSibling : container.firstChild
    const at = new Map<Node, number>()
    let n = 0
    for (let c = first; c && c !== before; ) {
      const next = c.nextSibling
      if (wanted.has(c)) at.set(c, n++)
      else c.remove()
      c = next
    }
    const stay = longestRun(roots.map((el) => at.get(el) ?? -1))
    let next: Node | null = before
    for (let i = roots.length - 1; i >= 0; i--) {
      const el = roots[i] as Element
      if (!stay.has(i)) container.insertBefore(el, next)
      next = el
    }
  }
}

/**
 * Fills `entries` with the entries of the last render that a block keeps, by key,
 * and returns the old entries nothing has claimed. Blocks that did not move
 * relative to the ends keep their entry first: this is what an edit, or a line
 * inserted, looks like, and it keeps identical blocks (a document of repeated
 * sections) from trading elements. In between, a block takes the first unused
 * entry with its key.
 */
function claimKept(
  prev: Entry[],
  keys: string[],
  entries: (Entry | undefined)[],
): Map<string, Entry[]> {
  const n = keys.length
  let head = 0
  while (head < n && head < prev.length && (prev[head] as Entry).key === keys[head]) {
    entries[head] = prev[head]
    head++
  }
  let tail = 0
  const last = prev.length - 1
  while (
    tail < n - head &&
    tail < prev.length - head &&
    (prev[last - tail] as Entry).key === keys[n - 1 - tail]
  ) {
    entries[n - 1 - tail] = prev[last - tail]
    tail++
  }
  const unused = new Map<string, Entry[]>()
  for (let i = head; i < prev.length - tail; i++) addTo(unused, prev[i] as Entry)
  for (let i = head; i < n - tail; i++) {
    entries[i] = unused.get(keys[i] as string)?.shift()
  }
  return unused
}

function addTo(map: Map<string, Entry[]>, entry: Entry): void {
  const list = map.get(entry.key)
  if (list) list.push(entry)
  else map.set(entry.key, [entry])
}

/**
 * Renders the blocks without an entry. A fresh block that renders as an unused old
 * one did keeps the old element (a playing video, a loaded image or player, a
 * ticked box, whatever else lives in it); one that is an edited block holding a
 * loaded embed keeps its element, patched. What is left unused is gone.
 */
function renderMissed(
  blocks: Block[],
  keys: string[],
  entries: (Entry | undefined)[],
  unused: Map<string, Entry[]>,
  env: BlockEnv,
  decorate?: (root: Element) => void,
): void {
  let old: Old | undefined
  for (let i = 0; i < blocks.length; i++) {
    if (entries[i]) continue
    const block = blocks[i] as Block
    const looked: string[] = []
    const fresh = renderBlock(
      block,
      env.images ? { ...env, images: watching(env.images, looked) } : env,
    )
    if (decorate) for (const root of fresh) decorate(root)
    old ??= oldElements(unused)
    const elements = keepOld(old, fresh) ?? fresh
    entries[i] = { key: keys[i] as string, images: looked, block, elements }
  }
}

/** The unused single-element entries: by a cheap look at their text, and those holding an embed. */
interface Old {
  looks: Map<string, Entry[]>
  held: Entry[]
  taken: Set<Entry>
}

// What is cheap to read from an element and equal for elements that look the same;
// only elements with the same sketch have their (costlier) rendered keys compared.
const sketch = (el: Element) => `${el.tagName}${el.textContent}`

function oldElements(unused: Map<string, Entry[]>): Old {
  const looks = new Map<string, Entry[]>()
  const held: Entry[] = []
  for (const list of unused.values()) {
    for (const e of list) {
      const el = e.elements[0]
      if (e.elements.length !== 1 || !el) continue
      const look = sketch(el)
      const same = looks.get(look)
      if (same) same.push(e)
      else looks.set(look, [e])
      if (holdsEmbed(el)) held.push(e)
    }
  }
  return { looks, held, taken: new Set() }
}

// The first unused old entry that renders as `only`, or null.
function lookAlike(old: Old, only: Element): Entry | null {
  const list = old.looks.get(sketch(only))
  if (!list) return null
  const key = renderedKey(only)
  const at = list.findIndex(
    (e) => !old.taken.has(e) && renderedKey(e.elements[0] as Element) === key,
  )
  return at < 0 ? null : (list.splice(at, 1)[0] as Entry)
}

// The elements of an old entry that `fresh` stands for, or null: one that looks the
// same, else a held one that `fresh` is an edit of, patched.
function keepOld(old: Old, fresh: Element[]): Element[] | null {
  const only = fresh[0]
  if (fresh.length !== 1 || !only) return null
  const same = lookAlike(old, only)
  if (same) {
    copyRenderedLines(only, same.elements[0] as Element)
    old.taken.add(same)
    return same.elements
  }
  const held = old.held.find(
    (e) => !old.taken.has(e) && patchHeldEmbed(e.elements[0] as Element, only),
  )
  if (!held) return null
  old.taken.add(held)
  return held.elements
}

/** Points each entry at its block now, stamps the roots' lines, returns the roots. */
function stampFresh(list: Entry[], blocks: Block[]): Element[] {
  const roots: Element[] = []
  list.forEach((entry, i) => {
    entry.block = blocks[i] as Block
    stamp(entry)
    roots.push(...entry.elements)
  })
  return roots
}

function stamp(entry: Entry): void {
  for (const el of entry.elements) {
    set(el, 'data-line', String(entry.block.line))
    set(el, 'data-line-end', String(entry.block.lineEnd))
  }
}

// The root nearest to entry `i` in direction `dir` (-1 up, 1 down), or null.
function edgeRoot(entries: Entry[], i: number, dir: 1 | -1): Element | null {
  for (let k = i; k >= 0 && k < entries.length; k += dir) {
    const els = (entries[k] as Entry).elements
    if (els.length) return (dir < 0 ? els.at(-1) : els[0]) ?? null
  }
  return null
}

// The resolver, noting the links it is asked about.
function watching(images: ImageResolver, looked: string[]): ImageResolver {
  return {
    lookup: (src) => {
      looked.push(src)
      return images.lookup(src)
    },
    owns: (url) => images.owns(url),
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
