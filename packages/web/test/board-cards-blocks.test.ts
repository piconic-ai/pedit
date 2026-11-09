// @vitest-environment jsdom

import MarkdownIt from 'markdown-it'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import * as blockrender from '../src/blockrender.ts'
import { BoardView } from '../src/board.ts'
import { EDGES, NODES, TEXT } from '../src/canvas.ts'
import type { PaneRenderer } from '../src/pane.ts'
import { loadEmbed, render, toggleRemember } from '../src/preview.ts'

beforeAll(() => {
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const views: BoardView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.element.remove()
})

const tick = () => new Promise((r) => setTimeout(r, 20))
const YT = 'https://youtu.be/dQw4w9WgXcQ'

function boardOf(
  texts: Record<string, string>,
  load: () => Promise<PaneRenderer> = async () => blockrender,
): { doc: Y.Doc; view: BoardView } {
  const doc = new Y.Doc()
  const nodes = Object.entries(texts).map(([id, text], i) => {
    const m = new Y.Map<unknown>()
    const t = new Y.Text()
    t.insert(0, text)
    for (const [k, v] of Object.entries({
      id,
      type: 'text',
      x: i * 300,
      y: 0,
      width: 250,
      height: 60,
    })) {
      m.set(k, v)
    }
    m.set(TEXT, t)
    return m
  })
  doc.getArray(NODES).push(nodes)
  doc.getArray(EDGES).push([])
  const view = new BoardView(doc, new Awareness(doc), { loadMarkdown: load })
  document.body.append(view.element)
  views.push(view)
  view.active = true
  return { doc, view }
}

const textOf = (doc: Y.Doc, id: string) => {
  for (const item of doc.getArray(NODES)) {
    if (item instanceof Y.Map && item.get('id') === id) return item.get(TEXT) as Y.Text
  }
  throw new Error(`no node ${id}`)
}

/** Sets a card's text as someone else did. */
const setText = (doc: Y.Doc, id: string, text: string) =>
  doc.transact(() => {
    const t = textOf(doc, id)
    t.delete(0, t.length)
    t.insert(0, text)
  }, 'remote')

const cards = (view: BoardView) => [...view.element.querySelectorAll('.canvas-markdown')]

// What a card shows, as a fresh whole-document render gives it: the roots' own lines
// and the card-only classes left out, and the lines nested in a root made absolute.
function shape(card: Element): string[] {
  return [...card.children].map((root) => {
    const copy = root.cloneNode(true) as Element
    const base = Number(root.getAttribute('data-line'))
    copy.removeAttribute('data-line-end')
    for (const el of copy.querySelectorAll('[data-line]')) {
      el.setAttribute('data-line', String(base + Number(el.getAttribute('data-line'))))
    }
    // A <pre> has no line of its own in a whole render; its <code> carries it.
    if (copy.tagName === 'PRE') copy.removeAttribute('data-line')
    return clean(copy.outerHTML)
  })
}

const clean = (html: string) => html.replace(/<pre data-line="\d+">/g, '<pre>')

function whole(text: string): string[] {
  const fragment = render(text, undefined, [], { breaks: true })
  // What the board adds to a card's links and players.
  for (const el of fragment.querySelectorAll('a, video, .embed'))
    el.classList.add('nodrag', 'nowheel')
  return [...fragment.children].map((el) => clean(el.outerHTML))
}

// A seeded generator, so a failing sequence can be replayed.
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PIECES = [
  '[a link](https://example.com/x) and https://example.com/y',
  `${YT}`,
  '- https://vimeo.com/76979871\n- item',
  '![](assets/x.png)',
  '# T',
  'a line',
  'two\nlines',
  '- x\n- y',
  '> q',
  '```\ncode\n```',
  '**b** _i_',
  '| a |\n|---|\n| 1 |',
  '',
]

describe('a card on the block renderer', () => {
  it(
    'shows what a whole render with line breaks shows, after random edits',
    async () => {
      const { doc, view } = boardOf({ a: 'start', b: 'other' })
      await tick()
      const [seeds, steps] = process.env.FUZZ ? [8, 30] : [2, 8]
      for (let seed = 1; seed <= seeds; seed++) {
        const next = rng(seed)
        for (let step = 0; step < steps; step++) {
          const count = 1 + Math.floor(next() * 5)
          const parts = Array.from(
            { length: count },
            () => PIECES[Math.floor(next() * PIECES.length)],
          )
          const text = parts.join(next() < 0.8 ? '\n\n' : '\n')
          setText(doc, 'a', text)
          await tick()
          expect(shape(cards(view)[0] as Element), `seed ${seed} step ${step}`).toEqual(whole(text))
        }
      }
      // The other card never changed.
      expect(shape(cards(view)[1] as Element)).toEqual(whole('other'))
    },
    process.env.FUZZ ? 60_000 : 5_000,
  )

  it('keeps a loaded player through edits elsewhere in its card and in other cards', async () => {
    const { doc, view } = boardOf({ a: `top\n\n${YT}\n\nbottom`, b: 'other' })
    await tick()
    const placeholder = view.element.querySelector('.canvas-markdown [data-embed-src]') as Element
    ;(placeholder.querySelector('.embed-load') as HTMLElement).click()
    const frame = view.element.querySelector('iframe')
    expect(frame).not.toBeNull()

    setText(doc, 'a', `TOP\n\n${YT}\n\nbottom`)
    await tick()
    expect(view.element.querySelector('iframe')).toBe(frame)
    setText(doc, 'a', `TOP\n\nnew\n\n${YT}\n\nbottom\nmore`)
    await tick()
    expect(view.element.querySelector('iframe')).toBe(frame)
    setText(doc, 'b', 'other, edited')
    await tick()
    expect(view.element.querySelector('iframe')).toBe(frame)
    expect(cards(view)[1]?.textContent).toContain('other, edited')
    // The player stays out of the way of dragging, as a placeholder does.
    expect(frame?.closest('.embed')?.classList.contains('nodrag')).toBe(true)
  })

  it('keeps a loaded player in a list while its other items change', async () => {
    const { doc, view } = boardOf({ a: `- ${YT}\n- x` })
    await tick()
    ;(view.element.querySelector('.embed-load') as HTMLElement).click()
    const frame = view.element.querySelector('iframe')
    setText(doc, 'a', `- ${YT}\n- xy\n- z`)
    await tick()
    expect(view.element.querySelector('iframe')).toBe(frame)
    expect(view.element.querySelector('li:last-child')?.textContent).toBe('z')
    expect(view.element.querySelector('.embed')?.classList.contains('nodrag')).toBe(true)
  })

  it('gives each card its own renderer and releases it when the card goes', async () => {
    const { doc, view } = boardOf({ a: 'one', b: 'two', c: 'three' })
    await tick()
    const [first, second] = cards(view) as HTMLElement[]
    expect(view.hasRenderer(first as HTMLElement)).toBe(true)
    expect(view.hasRenderer(second as HTMLElement)).toBe(true)
    const release = vi.spyOn(view, 'releaseMarkdown')
    remote(doc, () => doc.getArray(NODES).delete(1, 1))
    await tick()
    expect(cards(view)).toHaveLength(2)
    expect(release).toHaveBeenCalledWith(second)
    expect(view.hasRenderer(second as HTMLElement)).toBe(false)
    expect(view.hasRenderer(first as HTMLElement)).toBe(true)
  })
})

describe('a card whose type changes, and a deleted card brought back', () => {
  it('releases the renderer when the card stops being text, and makes one again', async () => {
    const { doc, view } = boardOf({ a: `one\n\n${YT}` })
    await tick()
    const el = cards(view)[0] as HTMLElement
    expect(view.hasRenderer(el)).toBe(true)
    const node = doc.getArray(NODES).get(0) as Y.Map<unknown>
    doc.transact(() => node.set('type', 'file'), 'remote')
    await tick()
    expect(view.hasRenderer(el)).toBe(false)
    expect(cards(view).every((c) => c.children.length === 0)).toBe(true)
    doc.transact(() => node.set('type', 'text'), 'remote')
    await tick()
    const back = cards(view)[0] as HTMLElement
    expect(view.hasRenderer(back)).toBe(true)
    expect(shape(back)).toEqual(whole(`one\n\n${YT}`))
  })

  it('draws a card again when its deletion is undone', async () => {
    const { view } = boardOf({ a: 'one\n\ntwo', b: 'x' })
    await tick()
    const store = view.store as unknown as { nodes: () => { id: string }[] }
    view.onNodesDelete(store.nodes().filter((n) => n.id === 'a') as never)
    await tick()
    expect(cards(view)).toHaveLength(1)
    view.onKey(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    await tick()
    expect(cards(view)).toHaveLength(2)
    const shown = cards(view).map((c) => shape(c))
    expect(shown).toContainEqual(whole('one\n\ntwo'))
    for (const c of cards(view)) expect(view.hasRenderer(c as HTMLElement)).toBe(true)
  })
})

describe('a loaded player in a list or quote', () => {
  const REPROS: [string, string][] = [
    [`- a\n- ${YT}\n- a`, `- a\n- a\n- ${YT}\n- a`],
    [`- x\n- ${YT}\n- y`, `- y\n- x\n- ${YT}\n- y`],
    [`- a\n- ${YT}\n- `, `- \n- a\n- ${YT}\n- `],
    [`> b\n>\n> ${YT}\n>\n> a`, `> a\n>\n> b\n>\n> ${YT}\n>\n> a`],
  ]

  function loaded(text: string) {
    const container = document.createElement('div')
    document.body.append(container)
    const blocks = new blockrender.BlockRenderer(container, { breaks: true })
    blocks.update(text, undefined, 0, [])
    const placeholder = container.querySelector('[data-embed-src]') as Element
    const frame = loadEmbed(placeholder)
    return { container, blocks, frame }
  }

  it.each(REPROS)('keeps it when an item is added above: %j', (before, after) => {
    const { container, blocks, frame } = loaded(before)
    expect(frame).not.toBeNull()
    blocks.update(after, undefined, 0, [])
    expect(container.querySelector('iframe')).toBe(frame)
  })

  it.each(REPROS)('keeps it in a card too: %j', async (before, after) => {
    const { doc, view } = boardOf({ a: before })
    await tick()
    ;(view.element.querySelector('.embed-load') as HTMLElement).click()
    const frame = view.element.querySelector('iframe')
    expect(frame).not.toBeNull()
    setText(doc, 'a', after)
    await tick()
    expect(view.element.querySelector('iframe')).toBe(frame)
  })

  it('keeps a ticked "Always load" box when an item is added above', () => {
    const before = '- x\n- https://vimeo.com/76979871\n- y'
    const container = document.createElement('div')
    const blocks = new blockrender.BlockRenderer(container)
    blocks.update(before, undefined, 0, [])
    const box = container.querySelector('.embed-remember') as Element
    toggleRemember(box)
    blocks.update('- y\n- x\n- https://vimeo.com/76979871\n- y', undefined, 0, [])
    expect(container.querySelector('.embed-remember')).toBe(box)
    expect(box.getAttribute('aria-checked')).toBe('true')
  })

  it(
    'keeps it through random edits to the other items',
    () => {
      const items = ['a', 'b', 'a', 'x y', '']
      const [seeds, steps] = process.env.FUZZ ? [200, 6] : [20, 4]
      for (let seed = 1; seed <= seeds; seed++) {
        const next = rng(seed)
        const pick = () => items[Math.floor(next() * items.length)] as string
        const list = [pick(), YT, pick()]
        const { container, blocks, frame } = loaded(list.map((i) => `- ${i}`).join('\n'))
        for (let step = 0; step < steps; step++) {
          const at = Math.floor(next() * (list.length + 1))
          const kind = next()
          const hold = list.indexOf(YT)
          if (kind < 0.6 || list.length < 3) list.splice(at, 0, pick())
          else {
            const other = list.findIndex((v, i) => v !== YT && i === at % list.length)
            if (other >= 0) list.splice(other, 1)
          }
          expect(hold).toBeGreaterThanOrEqual(0)
          blocks.update(list.map((i) => `- ${i}`).join('\n'), undefined, 0, [])
          expect(container.querySelector('iframe'), `seed ${seed} step ${step}: ${list}`).toBe(
            frame,
          )
        }
      }
    },
    process.env.FUZZ ? 60_000 : 5_000,
  )
})

function remote(doc: Y.Doc, fn: () => void) {
  doc.transact(fn, 'remote')
}

describe('performance guard', () => {
  // Counted by calls, never by time. The board may mount a card's element more than
  // once (only one is on screen), so the calls are those of the renderer on screen.
  const inline = vi.spyOn(Object.getPrototypeOf(new MarkdownIt().inline), 'parse')
  const sanitised = vi.spyOn(DOMParser.prototype, 'parseFromString')
  const seen = { inline: 0, sanitise: 0 }

  class Counting extends blockrender.BlockRenderer {
    #el: Element
    constructor(el: Element, options?: { breaks?: boolean; decorate?: (root: Element) => void }) {
      super(el, options)
      this.#el = el
    }
    override update(...args: Parameters<blockrender.BlockRenderer['update']>): void {
      const [i, s] = [inline.mock.calls.length, sanitised.mock.calls.length]
      super.update(...args)
      if (!this.#el.isConnected) return
      seen.inline += inline.mock.calls.length - i
      seen.sanitise += sanitised.mock.calls.length - s
    }
  }

  it('editing one card re-renders only its changed block', async () => {
    const { doc, view } = boardOf({ a: 'one\n\ntwo\n\nthree\n\nfour', b: 'x\n\ny' }, async () => ({
      ...blockrender,
      BlockRenderer: Counting,
    }))
    await tick()
    const before = [...(cards(view)[0] as Element).children]
    seen.inline = seen.sanitise = 0
    setText(doc, 'a', 'one\n\ntwo!\n\nthree\n\nfour')
    await tick()
    expect(seen).toEqual({ inline: 1, sanitise: 1 })
    const after = [...(cards(view)[0] as Element).children]
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[2]).toBe(before[2])
    expect(after[3]).toBe(before[3])
  })
})
