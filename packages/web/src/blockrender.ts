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
    const keys = blocks.map((b) => keyOf(b, refs, imagesVersion, this.#breaks))
    const entries: (Entry | undefined)[] = new Array(blocks.length)
    const unused = claimKept(this.#entries, keys, entries)
    renderMissed(blocks, keys, entries, unused, env)
    const list = entries as Entry[]
    if (images) reportShown(list, images)
    this.#entries = list
    this.#reconcile(stampLines(list, blocks))
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
 * Renders the blocks without an entry. One that is an edited block holding a
 * loaded embed keeps that element, patched; what is left unused is gone.
 */
function renderMissed(
  blocks: Block[],
  keys: string[],
  entries: (Entry | undefined)[],
  unused: Map<string, Entry[]>,
  env: BlockEnv,
): void {
  let held: Entry[] | undefined
  for (let i = 0; i < blocks.length; i++) {
    if (entries[i]) continue
    const block = blocks[i] as Block
    const looked: string[] = []
    const fresh = renderBlock(
      block,
      env.images ? { ...env, images: watching(env.images, looked) } : env,
    )
    held ??= [...unused.values()]
      .flat()
      .filter((e) => e.elements.length === 1 && holdsEmbed(e.elements[0] as Element))
    const elements = keepHeld(held, fresh) ?? fresh
    entries[i] = { key: keys[i] as string, images: looked, block, elements }
  }
}

// The elements of a held entry that `fresh` is an edit of, patched, or null.
function keepHeld(held: Entry[], fresh: Element[]): Element[] | null {
  const only = fresh[0]
  if (fresh.length !== 1 || !only) return null
  const at = held.findIndex((e) => patchHeldEmbed(e.elements[0] as Element, only))
  return at < 0 ? null : (held.splice(at, 1)[0] as Entry).elements
}

// Cached blocks do not look their images up again, so say that they are shown: the
// resolver keeps what is on screen from being evicted.
function reportShown(list: Entry[], images: ImageResolver): void {
  for (const e of list) for (const src of e.images) images.lookup(src)
}

/** Points each entry at its block now, stamps the roots' lines, returns the roots. */
function stampLines(list: Entry[], blocks: Block[]): Element[] {
  const roots: Element[] = []
  list.forEach((entry, i) => {
    entry.block = blocks[i] as Block
    for (const el of entry.elements) {
      set(el, 'data-line', String(entry.block.line))
      set(el, 'data-line-end', String(entry.block.lineEnd))
      roots.push(el)
    }
  })
  return roots
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
