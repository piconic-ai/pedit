// @vitest-environment jsdom
import type { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { type Anchor, followTarget, monotonic, PreviewPane, scrollTarget } from '../src/pane.ts'

const tops = new WeakMap<Element, number>()

// Deterministic layout: every element's top comes from the `tops` map.
const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
  this: Element,
) {
  // Blocks move up as their article scrolls, as in a browser.
  const top = (tops.get(this) ?? 0) - (this.parentElement?.closest('article')?.scrollTop ?? 0)
  return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect
})
const query = vi.spyOn(Element.prototype, 'querySelectorAll')

afterEach(() => {
  rect.mockClear()
  query.mockClear()
})

/** The full computation `follow` did before: every block's rect. */
function full(pane: HTMLElement, line: number, docLines: number): number {
  const origin = pane.getBoundingClientRect().top - pane.scrollTop
  const anchors: Anchor[] = []
  for (const root of pane.children) {
    if (!(root instanceof HTMLElement) || root.dataset.line === undefined) continue
    const base = Number(root.dataset.line)
    anchors.push({ line: base, top: root.getBoundingClientRect().top - origin })
    for (const el of root.querySelectorAll<HTMLElement>('[data-line]')) {
      anchors.push({
        line: base + Number(el.dataset.line),
        top: el.getBoundingClientRect().top - origin,
      })
    }
  }
  anchors.push({ line: docLines, top: pane.scrollHeight })
  return scrollTarget(monotonic(anchors), line)
}

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** A random article: roots in order with absolute lines, nested blocks, pre roots, line-less roots. */
function layout(seed: number) {
  const rand = rng(seed)
  const pane = document.createElement('article')
  Object.defineProperty(pane, 'scrollHeight', { value: 100000, configurable: true })
  const roots = 1 + Math.floor(rand() * 40)
  let line = rand() < 0.3 ? Math.floor(rand() * 4) : 0
  let top = 0
  for (let i = 0; i < roots; i++) {
    const kind = rand()
    const span = 1 + Math.floor(rand() * 8)
    const height = 10 + Math.floor(rand() * 200)
    const root = document.createElement(kind < 0.15 ? 'pre' : kind < 0.3 ? 'ul' : 'p')
    tops.set(root, top)
    if (kind > 0.9) {
      // An error paragraph or the like: no line.
      pane.append(root)
      top += height
      continue
    }
    root.dataset.line = String(line)
    root.dataset.lineEnd = String(line + span)
    if (root.tagName === 'UL') {
      for (let k = 0; k < span; k++) {
        const li = document.createElement('li')
        li.dataset.line = String(k)
        // Mostly in order, sometimes not (an image grew, a tall embed).
        tops.set(li, top + Math.floor(rand() * height * (rand() < 0.3 ? 1 : 0.5)))
        root.append(li)
      }
    }
    pane.append(root)
    line += span + (rand() < 0.3 ? 1 : 0)
    top += height
  }
  return { pane, lines: line + 1 }
}

describe('followTarget', () => {
  it('equals the full computation over random layouts and lines', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { pane, lines } = layout(seed)
      const rand = rng(seed * 7)
      const targets = [0, 0.5, lines - 1, lines, lines + 3]
      for (let k = 0; k < 20; k++) targets.push(rand() * (lines + 1))
      for (const line of targets) {
        expect(followTarget(pane, line, lines), `seed ${seed} line ${line}`).toBeCloseTo(
          full(pane, line, lines),
          9,
        )
      }
    }
  })

  it('starts at the first of several roots sharing a line', () => {
    const pane = document.createElement('article')
    Object.defineProperty(pane, 'scrollHeight', { value: 5000 })
    const lines = [0, 5, 5, 5, 9, 9, 14]
    lines.forEach((l, i) => {
      const p = document.createElement('p')
      p.dataset.line = String(l)
      tops.set(p, i * 300)
      pane.append(p)
    })
    for (const line of [0, 4.5, 5, 6, 8.9, 9, 10, 13, 14, 20]) {
      expect(followTarget(pane, line, 16), `line ${line}`).toBeCloseTo(full(pane, line, 16), 9)
    }
  })

  it('scrolls an empty preview to the top', () => {
    const pane = document.createElement('article')
    Object.defineProperty(pane, 'scrollHeight', { value: 0 })
    expect(followTarget(pane, 5, 10)).toBe(full(pane, 5, 10))
    expect(followTarget(pane, 5, 10)).toBe(0)
  })

  it('reads a handful of elements on a document with thousands of roots', () => {
    const pane = document.createElement('article')
    Object.defineProperty(pane, 'scrollHeight', { value: 1e6 })
    for (let i = 0; i < 5000; i++) {
      const p = document.createElement('p')
      p.dataset.line = String(i * 2)
      tops.set(p, i * 20)
      pane.append(p)
    }
    for (const line of [0, 1, 4001, 7777.5, 9999, 20000]) {
      rect.mockClear()
      query.mockClear()
      expect(followTarget(pane, line, 10000)).toBeCloseTo(full(pane, line, 10000), 9)
      rect.mockClear()
      query.mockClear()
      followTarget(pane, line, 10000)
      expect(rect.mock.calls.length).toBeLessThanOrEqual(4)
      expect(query.mock.calls.length).toBeLessThanOrEqual(2)
    }
  })
})

describe('PreviewPane.follow skips unchanged work', () => {
  function editor(top: number) {
    const scrollDOM = { scrollTop: 10, scrollHeight: 1000, clientHeight: 500 }
    return {
      scrollDOM,
      documentPadding: { top: 0 },
      lineBlockAtHeight: () => ({ from: 0, top: 10, height: 20 }),
      state: { doc: { lines: 30, lineAt: () => ({ number: top + 1 }) } },
    } as unknown as EditorView
  }

  function setup() {
    const pane = new PreviewPane(new Y.Doc().getText('content'))
    let scrollTop = 0
    let scrollHeight = 3000
    Object.defineProperty(pane.element, 'scrollTop', {
      get: () => scrollTop,
      set: (v) => void (scrollTop = v),
    })
    Object.defineProperty(pane.element, 'scrollHeight', { get: () => scrollHeight })
    Object.defineProperty(pane.element, 'clientHeight', { value: 500 })
    for (let i = 0; i < 6; i++) {
      const p = document.createElement('p')
      p.dataset.line = String(i * 5)
      tops.set(p, i * 400)
      pane.element.append(p)
    }
    return { pane, setHeight: (h: number) => void (scrollHeight = h), at: () => scrollTop }
  }

  it('does not read the layout again for the same line and layout', () => {
    const { pane, at } = setup()
    const view = editor(10)
    pane.follow(view)
    expect(at()).toBe(800)
    rect.mockClear()
    pane.follow(view)
    expect(rect).not.toHaveBeenCalled()
  })

  it('follows again when the line, the height or the reader moved the preview', () => {
    const { pane, setHeight, at } = setup()
    const view = editor(10)
    pane.follow(view)
    const moved = editor(15)
    pane.follow(moved)
    expect(at()).toBe(1200)
    setHeight(2900)
    rect.mockClear()
    pane.follow(moved)
    expect(rect).toHaveBeenCalled()
    // The reader scrolls the preview by hand; the next follow brings it back.
    pane.element.scrollTop = 0
    pane.follow(moved)
    expect(at()).toBe(1200)
  })
})
