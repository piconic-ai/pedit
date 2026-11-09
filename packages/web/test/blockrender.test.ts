// @vitest-environment jsdom

import type { EditorView } from '@codemirror/view'
import MarkdownIt from 'markdown-it'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import * as preview from '../src/blockrender.ts'
import { BlockRenderer } from '../src/blockrender.ts'
import type { ImageResolver } from '../src/core/attachments.ts'
import { PreviewPane } from '../src/pane.ts'
import { loadEmbed, render, toggleRemember } from '../src/preview.ts'
import corpus from './fixtures/preview-corpus.json'

const MEDIA: readonly string[] = []
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

function setup(source = '', breaks = false) {
  const container = document.createElement('article')
  document.body.replaceChildren(container)
  const renderer = new BlockRenderer(container, { breaks })
  const update = (text: string, images?: ImageResolver, version = 0) =>
    renderer.update(text, images, version, MEDIA)
  if (source) update(source)
  return { container, renderer, update }
}

const roots = (container: Element) => [...container.children]

/**
 * The container as main would show it, per root: nested lines made absolute, the
 * root-only `data-line-end` dropped, and the root's own `data-line` dropped where
 * main has none (a <pre>: its <code> carries the line) so the rest compares as is.
 */
function normalised(container: Element, expected: string[]): string[] {
  const holder = document.createElement('div')
  return roots(container).map((root, i) => {
    const copy = root.cloneNode(true) as Element
    const base = Number(root.getAttribute('data-line'))
    copy.removeAttribute('data-line-end')
    for (const el of copy.querySelectorAll('[data-line]')) {
      el.setAttribute('data-line', String(base + Number(el.getAttribute('data-line'))))
    }
    holder.innerHTML = expected[i] ?? ''
    if (!holder.firstElementChild?.hasAttribute('data-line')) copy.removeAttribute('data-line')
    return copy.outerHTML
  })
}

function whole(source: string, images?: ImageResolver, breaks = false): string[] {
  return [...render(source, images, MEDIA, { breaks }).children].map((el) => el.outerHTML)
}

function expectLikeWhole(
  container: Element,
  source: string,
  options: { images?: ImageResolver; breaks?: boolean } = {},
  message?: string,
): void {
  const expected = whole(source, options.images, options.breaks)
  expect(normalised(container, expected), message).toEqual(expected)
}

// A small seeded generator, so a failing sequence can be replayed.
function rng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function doc(lines: number): string {
  const block = [
    '# Heading *one* with `code`',
    '',
    'A paragraph with **bold**, _em_, [a link](https://ex.com "t") and `code`.',
    'Second line with ~~strike~~ and an &amp; entity and 日本語 text.',
    '',
    '- item one',
    '- item [x](u) two',
    '  - nested *em*',
    '',
    '> quote line',
    '> more quote',
    '',
    '| a | b | c |',
    '|---|:-:|--:|',
    '| 1 | `2` | **3** |',
    '| x \\| y | z | w |',
    '',
    '```js',
    'const x = 1',
    'console.log(x)',
    '```',
    '',
    '1. one',
    '2. two',
    '',
  ]
  const out: string[] = []
  while (out.length < lines) out.push(...block)
  return `${out.slice(0, lines).join('\n')}\n`
}

describe('BlockRenderer output', () => {
  it('equals a full render after each of many random edits over the corpus', () => {
    const pieces = (corpus as [string, string][]).map(([, src]) => src)
    for (const seed of [1, 2, 3, 4]) {
      const next = rng(seed)
      const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)] as T
      const { container, update } = setup()
      let lines = Array.from({ length: 8 }, () => pick(pieces))
        .join('\n\n')
        .split('\n')
      update(lines.join('\n'))
      for (let step = 0; step < 40; step++) {
        const at = Math.floor(next() * (lines.length + 1))
        const op = Math.floor(next() * 5)
        if (op === 0) lines.splice(at, 0, ...pick(pieces).split('\n'))
        else if (op === 1) lines.splice(at, Math.floor(next() * 4))
        else if (op === 2) {
          const [moved] = [lines.splice(at, 1 + Math.floor(next() * 3))]
          lines.splice(Math.floor(next() * (lines.length + 1)), 0, ...moved.flat())
        } else if (op === 3 && lines[at] !== undefined) {
          // A change inside a line: a character in or out.
          const line = lines[at] as string
          const c = Math.floor(next() * (line.length + 1))
          lines[at] =
            next() < 0.5
              ? line.slice(0, c) + pick(['*', '[', '`', ' ', '#', '>', '-']) + line.slice(c)
              : line.slice(0, c) + line.slice(c + 1)
        } else lines.splice(at, 0, '')
        const source = lines.join('\n')
        update(source)
        expectLikeWhole(
          container,
          source,
          {},
          `seed ${seed} step ${step}: ${JSON.stringify(source)}`,
        )
        for (const n of container.childNodes) expect(n.nodeType).toBe(Node.ELEMENT_NODE)
      }
    }
  })

  it('equals a full render with breaks on', () => {
    const { container, update } = setup('', true)
    const source = 'one\ntwo\n\n- a\n  b\n'
    update(source)
    expectLikeWhole(container, source, { breaks: true })
  })

  it('shows nothing for an empty text and clears what was there', () => {
    const { container, update } = setup('# a\n\nb')
    expect(roots(container)).toHaveLength(2)
    update('')
    expect(container.childNodes).toHaveLength(0)
  })

  it('removes nodes it did not put there', () => {
    const { container, update } = setup()
    container.append(document.createTextNode('\n'), document.createElement('i'))
    update('# a\n')
    expect(container.innerHTML).toBe('<h1 data-line="0" data-line-end="1">a</h1>')
  })
})

describe('identity', () => {
  const source = '# One\n\nTwo\n\n- three\n- four\n\n> five\n'

  it('an edit elsewhere leaves the other blocks the same elements', () => {
    const { container, update } = setup(source)
    const before = roots(container)
    update(source.replace('Two', 'Too'))
    const after = roots(container)
    expect(after).toHaveLength(4)
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[2]).toBe(before[2])
    expect(after[3]).toBe(before[3])
    expect(after[1]?.textContent).toBe('Too')
  })

  it('keeps what was done to a block, such as a changed style, across an edit elsewhere', () => {
    const { container, update } = setup(source)
    const list = roots(container)[2] as HTMLElement
    list.classList.add('mine')
    update(`${source}\nmore\n`)
    expect(roots(container)[2]).toBe(list)
    expect(list.classList.contains('mine')).toBe(true)
  })

  it('gives identical blocks their own elements', () => {
    const { container, update } = setup('same\n\nsame\n\nsame\n')
    const [a, b, c] = roots(container)
    expect(new Set([a, b, c]).size).toBe(3)
    update('same\n\nsame\n')
    // The first two stay, the third goes.
    expect(roots(container)).toEqual([a, b])
    update('same\n\nsame\n\nsame\n\nsame\n')
    const four = roots(container)
    expect(four.slice(0, 2)).toEqual([a, b])
    expect(new Set(four).size).toBe(4)
  })

  it('inserts and removes blocks without touching the rest', () => {
    const { container, update } = setup('a\n\nb\n\nc\n')
    const [a, b, c] = roots(container)
    update('a\n\nnew\n\nb\n\nc\n')
    const withNew = roots(container)
    expect([withNew[0], withNew[2], withNew[3]]).toEqual([a, b, c])
    expect(withNew[1]?.textContent).toBe('new')
    update('a\n\nc\n')
    expect(roots(container)).toEqual([a, c])
  })

  it('moves one block with one DOM move, and the others stay', () => {
    const { container, update } = setup('a\n\nb\n\nc\n\nd\n\ne\n')
    const [a, b, c, d, e] = roots(container)
    const seen: MutationRecord[] = []
    const observer = new MutationObserver((r) => seen.push(...r))
    observer.observe(container, { childList: true })
    update('b\n\nc\n\nd\n\ne\n\na\n')
    seen.push(...observer.takeRecords())
    observer.disconnect()
    expect(roots(container)).toEqual([b, c, d, e, a])
    // `a` out of the front and back in at the end: no other node is touched.
    const touched = new Set(seen.flatMap((r) => [...r.addedNodes, ...r.removedNodes]))
    expect([...touched]).toEqual([a])
  })

  it('swaps two blocks moving only one', () => {
    const { container, update } = setup('a\n\nb\n\nc\n')
    const [a, b, c] = roots(container)
    update('a\n\nc\n\nb\n')
    expect(roots(container)).toEqual([a, c, b])
  })
})

describe('lines', () => {
  it('stamps absolute lines on the roots and keeps nested ones relative', () => {
    const { container, update } = setup('# T\n\n- a\n- b\n- c\n\npara\n')
    const [h, ul, p] = roots(container)
    expect([h, ul, p].map((e) => e?.getAttribute('data-line'))).toEqual(['0', '2', '6'])
    expect([h, ul, p].map((e) => e?.getAttribute('data-line-end'))).toEqual(['1', '6', '7'])
    expect([...(ul?.children ?? [])].map((li) => li.getAttribute('data-line'))).toEqual([
      '0',
      '1',
      '2',
    ])
    update('new\n\n# T\n\n- a\n- b\n- c\n\npara\n')
    expect(roots(container)[1]).toBe(h)
    expect(roots(container).map((e) => e.getAttribute('data-line'))).toEqual(['0', '2', '4', '8'])
    expect(ul?.getAttribute('data-line-end')).toBe('8')
    expect([...(ul?.children ?? [])].map((li) => li.getAttribute('data-line'))).toEqual([
      '0',
      '1',
      '2',
    ])
  })

  it('only writes the attributes that changed', () => {
    const { container, update } = setup('a\n\nb\n\nc\n')
    const seen: MutationRecord[] = []
    const observer = new MutationObserver((r) => seen.push(...r))
    observer.observe(container, { subtree: true, attributes: true })
    update('a\n\nb\n\nc\n\nd\n')
    expect(observer.takeRecords().filter((r) => r.type === 'attributes')).toEqual([])
    update('x\n\na\n\nb\n\nc\n\nd\n')
    const names = observer.takeRecords().map((r) => r.attributeName)
    expect(new Set(names)).toEqual(new Set(['data-line', 'data-line-end']))
  })
})

describe('what a block holds survives', () => {
  const frames = (el: Element) => el.querySelectorAll('iframe')

  it('a loaded player stays put while other blocks change, appear above and move', () => {
    const { container, update } = setup(`intro\n\n${YT}\n\noutro\n`)
    const placeholder = container.querySelector('.embed') as HTMLElement
    const frame = loadEmbed(placeholder)
    expect(frame).not.toBeNull()
    update(`intro changed\n\n${YT}\n\noutro\n`)
    expect(container.querySelector('.embed')).toBe(placeholder)
    expect(placeholder.firstElementChild).toBe(frame)
    update(`new above\n\nintro changed\n\n${YT}\n\noutro\n\nbelow\n`)
    expect(container.querySelector('.embed')).toBe(placeholder)
    expect(frames(container)).toHaveLength(1)
    expect(placeholder.firstElementChild).toBe(frame)
    // Its root carries the line it has now.
    expect(placeholder.closest('p, div')?.getAttribute('data-line')).toBe('4')
  })

  it('a player that is a whole block stays loaded when text is appended after it', () => {
    // Appending after the last line gives that block a trailing newline, which is a
    // new key: the loaded placeholder is the block's root and must still be kept.
    const { container, update } = setup(YT)
    const placeholder = container.querySelector('.embed') as HTMLElement
    const frame = loadEmbed(placeholder)
    update(`${YT}\n\nmore`)
    expect(container.querySelector('.embed')).toBe(placeholder)
    expect(placeholder.firstElementChild).toBe(frame)
    expect(placeholder.getAttribute('data-line')).toBe('0')
    update(`new\n\n${YT}\n\nmore`)
    expect(container.querySelector('.embed')).toBe(placeholder)
    expect(placeholder.getAttribute('data-line')).toBe('2')
  })

  it('a ticked box stays ticked', () => {
    const { container, update } = setup(`${YT}\n\nafter\n`)
    const box = container.querySelector('.embed-remember') as Element
    expect(toggleRemember(box)).toBe(true)
    update(`${YT}\n\nafter!\n`)
    expect(container.querySelector('.embed-remember')).toBe(box)
    expect(box.getAttribute('aria-checked')).toBe('true')
  })

  it('a loaded player in a list stays loaded while another item of that list is edited', () => {
    const { container, update } = setup(`- ${YT}\n- one\n- two\n\nafter\n`)
    const placeholder = container.querySelector('.embed') as HTMLElement
    const frame = loadEmbed(placeholder)
    const list = container.querySelector('ul') as Element
    update(`- ${YT}\n- one edited\n- two\n\nafter\n`)
    // The list is a new block, but its player was patched in place, not reloaded.
    expect(container.querySelector('ul')).toBe(list)
    expect(container.querySelector('.embed')).toBe(placeholder)
    expect(placeholder.firstElementChild).toBe(frame)
    expect([...container.querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual([
      '',
      'one edited',
      'two',
    ])
    // Another edit in the list, this time at its start, still keeps the player.
    update(`- first\n- ${YT}\n- one edited\n- two\n\nafter\n`)
    expect(container.querySelector('.embed')).toBe(placeholder)
    expect(placeholder.firstElementChild).toBe(frame)
    expect(container.querySelectorAll('li')).toHaveLength(4)
    expect(list.getAttribute('data-line')).toBe('0')
    // And the result is the list main would show.
  })

  it('does not hand a loaded player to an unrelated new block of the same shape', () => {
    const { container, update } = setup(`- ${YT}\n- one\n`)
    const placeholder = container.querySelector('.embed') as HTMLElement
    loadEmbed(placeholder)
    update('- plain\n- list\n')
    expect(container.querySelector('.embed')).toBeNull()
    expect(frames(container)).toHaveLength(0)
  })

  it('reset shows nothing and forgets the blocks', () => {
    const { container, renderer, update } = setup('a\n\nb\n')
    const [a] = roots(container)
    renderer.reset()
    expect(container.childNodes).toHaveLength(0)
    update('a\n\nb\n')
    expect(roots(container)[0]).not.toBe(a)
  })

  it('the cache lets go of blocks that are gone', () => {
    const { container, update } = setup('a\n\nb\n')
    const [, b] = roots(container)
    update('a\n')
    update('a\n\nb\n')
    // `b` was dropped from the cache, so it is a new element, not the old one.
    expect(roots(container)[1]).not.toBe(b)
  })
})

describe('images', () => {
  it('blocks with an image render again when the images version changes, the others do not', () => {
    let url: string | null = null
    const images: ImageResolver = {
      lookup: () => (url ? { url } : 'loading'),
      owns: (u: string) => u === url,
    }
    const source = 'text\n\n![](assets/0123456789abcdef0123456789abcdef.png)\n\nmore [x](u)\n'
    const { container, update } = setup()
    update(source, images, 0)
    const before = roots(container)
    expect(before[1]?.querySelector('.loading-image')).not.toBeNull()
    url = 'blob:http://localhost/1'
    update(source, images, 0)
    // Nothing told it, so nothing changed.
    expect(roots(container)[1]).toBe(before[1])
    update(source, images, 1)
    const after = roots(container)
    expect(after[1]).not.toBe(before[1])
    expect(after[1]?.querySelector('img')?.getAttribute('src')).toBe(url)
    expect(after[0]).toBe(before[0])
    expect(after[2]).toBe(before[2])
  })
})

describe('performance guards', () => {
  // Counted by calls, never by time. The inline parser runs once per inline token
  // (a block here is one or a few), the sanitiser once per block through DOMParser.
  const inline = vi.spyOn(Object.getPrototypeOf(new MarkdownIt().inline), 'parse')
  const sanitised = vi.spyOn(DOMParser.prototype, 'parseFromString')
  const counts = () => ({ inline: inline.mock.calls.length, sanitise: sanitised.mock.calls.length })
  const reset = () => {
    inline.mockClear()
    sanitised.mockClear()
  }

  it('one edit in a 2,000-line document renders one block', () => {
    const source = doc(2000)
    const { container, update } = setup()
    update(source)
    const blocks = container.children.length
    expect(blocks).toBeGreaterThan(500)
    const before = roots(container)
    reset()
    const observer = new MutationObserver(() => {})
    observer.observe(container, { childList: true })
    update(source.replace('A paragraph', 'A Paragraph'))
    const records = observer.takeRecords()
    observer.disconnect()
    // The edited paragraph: one inline parse for its inline token, one sanitise.
    expect(counts()).toEqual({ inline: 1, sanitise: 1 })
    expect(records.length).toBeLessThanOrEqual(2)
    const after = roots(container)
    expect(after).toHaveLength(blocks)
    expect(after.filter((el, i) => el !== before[i])).toHaveLength(1)
  })

  it('a line inserted at the top renders nothing and changes only line attributes', () => {
    const source = doc(2000)
    const { container, update } = setup()
    update(source)
    const before = roots(container)
    reset()
    const observer = new MutationObserver(() => {})
    observer.observe(container, { subtree: true, childList: true, attributes: true })
    update(`\n${source}`)
    const records = observer.takeRecords()
    observer.disconnect()
    expect(counts()).toEqual({ inline: 0, sanitise: 0 })
    expect(roots(container)).toEqual(before)
    expect(records.filter((r) => r.type === 'childList')).toEqual([])
    expect(new Set(records.map((r) => r.attributeName))).toEqual(
      new Set(['data-line', 'data-line-end']),
    )
    expect(container.firstElementChild?.getAttribute('data-line')).toBe('1')
  })

  it('a first render and an unchanged update', () => {
    const { container, update } = setup()
    reset()
    update(doc(200))
    expect(counts().sanitise).toBe(container.children.length)
    reset()
    update(doc(200))
    expect(counts()).toEqual({ inline: 0, sanitise: 0 })
  })
})

describe('PreviewPane follow with relative lines', () => {
  function sized<T extends HTMLElement | object>(target: T, size: Record<string, number>): T {
    let top = size.scrollTop ?? 0
    Object.defineProperty(target, 'scrollTop', { get: () => top, set: (v) => void (top = v) })
    Object.defineProperty(target, 'scrollHeight', { value: size.scrollHeight })
    Object.defineProperty(target, 'clientHeight', { value: size.clientHeight })
    return target
  }

  // An editor showing the (0-based) line `line` at its top.
  function editorAt(line: number, lines: number): EditorView {
    return {
      scrollDOM: sized({}, { scrollTop: 100, scrollHeight: 100000, clientHeight: 500 }),
      documentPadding: { top: 0 },
      lineBlockAtHeight: () => ({ from: 0, top: 100, height: 20 }),
      state: { doc: { lines, lineAt: () => ({ number: line + 1 }) } },
    } as unknown as EditorView
  }

  // Lays the article out at 10px per source line, found from the text of each element.
  function layOut(pane: PreviewPane, source: string): void {
    const rows = source.split('\n')
    const line = (el: Element) => {
      const text = (el.firstChild?.textContent ?? '').trim() || (el.textContent ?? '').trim()
      return rows.findIndex((r) =>
        r
          .replace(/^[-#>\s]+/, '')
          .trim()
          .startsWith(text.slice(0, 5)),
      )
    }
    for (const el of pane.element.querySelectorAll('[data-line]')) {
      const top = line(el) * 10
      // Like a browser, what is scrolled past is above the pane's top.
      el.getBoundingClientRect = () => ({ top: top - pane.element.scrollTop }) as DOMRect
    }
    pane.element.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  }

  async function shown(source: string) {
    const text = new Y.Doc().getText('content')
    text.insert(0, source)
    const pane = new PreviewPane(text, { load: () => Promise.resolve(preview) })
    pane.active = true
    await vi.waitFor(() => expect(pane.element.children.length).toBeGreaterThan(0))
    sized(pane.element, { scrollHeight: 100000, clientHeight: 500 })
    return { text, pane }
  }

  const source =
    '# Title\n\nintro text\n\n- alpha\n- bravo\n- charlie\n  - delta\n\nlast paragraph\n'

  it('lines a nested element up with its own source line', async () => {
    const { pane } = await shown(source)
    layOut(pane, source)
    // Line 5 is "- bravo", the second item of a list that starts at line 4.
    pane.follow(editorAt(5, 10))
    expect(pane.element.scrollTop).toBe(50)
    pane.follow(editorAt(7, 10))
    expect(pane.element.scrollTop).toBe(70)
    // Between "- bravo" and "- charlie", half way.
    pane.follow(editorAt(4, 10))
    expect(pane.element.scrollTop).toBe(40)
  })

  it('follows the same lines after a line is inserted above, without rendering the list again', async () => {
    const { text, pane } = await shown(source)
    const list = pane.element.querySelector('ul')
    text.insert(0, 'new\n\n')
    await vi.waitFor(() => expect(pane.element.children[0]?.textContent).toBe('new'))
    expect(pane.element.querySelector('ul')).toBe(list)
    const moved = `new\n\n${source}`
    layOut(pane, moved)
    pane.follow(editorAt(7, 12))
    expect(pane.element.scrollTop).toBe(70)
    pane.follow(editorAt(9, 12))
    expect(pane.element.scrollTop).toBe(90)
  })
})

describe('editing back a block that holds a loaded player', () => {
  const li = (c: Element) => [...c.querySelectorAll('li')].map((x) => x.textContent?.trim())

  it('shows the earlier form again, not the patched one (loaded)', () => {
    const { container, update } = setup(`- ${YT}\n- one\n`)
    const placeholder = container.querySelector('.embed') as HTMLElement
    const frame = loadEmbed(placeholder)
    update(`- ${YT}\n- one edited\n`)
    expect(li(container)).toEqual(['', 'one edited'])
    update(`- ${YT}\n- one\n`)
    expect(li(container)).toEqual(['', 'one'])
    expect(placeholder.firstElementChild).toBe(frame)
  })

  it('shows the earlier form again, not the patched one (ticked)', () => {
    const { container, update } = setup(`- ${YT}\n- one\n`)
    toggleRemember(container.querySelector('.embed-remember') as Element)
    update(`- ${YT}\n- one edited\n`)
    update(`- ${YT}\n- one\n`)
    expect(li(container)).toHaveLength(2)
    expect(li(container)[1]).toBe('one')
    expect(container.querySelector('.embed-remember')?.getAttribute('aria-checked')).toBe('true')
  })

  it('does not keep an item that was added and removed again', () => {
    const { container, update } = setup(`intro\n\n- ${YT}\n- x\n`)
    loadEmbed(container.querySelector('.embed') as HTMLElement)
    update(`intro\n\n- a\n\n- ${YT}\n- x\n`)
    update(`intro\n\n- ${YT}\n- x\n`)
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  // Embeds are masked: a loaded one differs from main's placeholder by design.
  function masked(el: Element): string {
    const copy = el.cloneNode(true) as Element
    for (const e of [copy, ...copy.querySelectorAll('[data-embed-src]')]) {
      if (!e.hasAttribute('data-embed-src')) continue
      const src = e.getAttribute('data-embed-src') ?? ''
      const line = e.getAttribute('data-line')
      e.replaceChildren()
      for (const a of [...e.attributes]) e.removeAttribute(a.name)
      e.setAttribute('data-embed-src', src)
      if (line !== null) e.setAttribute('data-line', line)
    }
    return copy.outerHTML
  }

  it('equals a full render after random edits with players loaded and ticked', () => {
    const pieces = [
      '# Head',
      'text',
      '',
      '',
      '- item',
      '  - nested',
      '1. one',
      '> quote',
      YT,
      `- ${YT}`,
      '- x',
      'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      '```',
      'more text',
      '- [ ] task',
    ]
    // jsdom builds a window for every iframe, which is slow: a plain element stands in.
    const create = document.createElement.bind(document)
    const stub = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag: string, o?: ElementCreationOptions) =>
        create(tag === 'iframe' ? 'span' : tag, o),
      )
    // A longer run: FUZZ=1.
    const [seeds, steps] = process.env.FUZZ ? [12, 50] : [6, 40]
    try {
      for (let seed = 1; seed <= seeds; seed++) {
        const next = rng(seed * 7 + 3)
        const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)] as T
        const { container, update } = setup()
        let lines = Array.from({ length: 8 }, () => pick(pieces))
        update(lines.join('\n'))
        for (let step = 0; step < steps; step++) {
          const holders = [...container.querySelectorAll('[data-embed-src]:not(.embed--loaded)')]
          if (holders.length && next() < 0.4) {
            const h = pick(holders)
            const box = h.querySelector('.embed-remember')
            if (next() < 0.5) loadEmbed(h, false)
            else if (box) toggleRemember(box)
          }
          const at = Math.floor(next() * (lines.length + 1))
          if (next() < 0.5) lines.splice(at, 0, pick(pieces))
          else lines.splice(at, 1 + Math.floor(next() * 2))
          // Often return to the form an earlier edit had: back and forth.
          if (next() < 0.2) lines = lines.slice()
          const source = lines.join('\n')
          update(source)
          const expected = [...render(source, undefined, MEDIA).children].map(masked)
          expect(
            roots(container)
              .map((r) => {
                const copy = r.cloneNode(true) as Element
                const base = Number(r.getAttribute('data-line'))
                copy.removeAttribute('data-line-end')
                for (const e of copy.querySelectorAll('[data-line]')) {
                  e.setAttribute('data-line', String(base + Number(e.getAttribute('data-line'))))
                }
                return masked(copy)
              })
              .map((h, i) => {
                const t = document.createElement('div')
                t.innerHTML = expected[i] ?? ''
                if (!t.firstElementChild?.hasAttribute('data-line')) {
                  const c = document.createElement('div')
                  c.innerHTML = h
                  c.firstElementChild?.removeAttribute('data-line')
                  return c.innerHTML
                }
                return h
              }),
            `seed ${seed} step ${step}: ${JSON.stringify(source)}`,
          ).toEqual(expected)
        }
      }
    } finally {
      stub.mockRestore()
    }
  })
})

describe('images on screen', () => {
  it('a block that is kept still tells the resolver its images are shown', () => {
    const looked: string[] = []
    const images: ImageResolver = {
      lookup: (src) => {
        looked.push(src)
        return { url: 'blob:http://localhost/1' }
      },
      owns: (u) => u === 'blob:http://localhost/1',
    }
    const img = 'assets/0123456789abcdef0123456789abcdef.png'
    const { container, update } = setup()
    update(`text\n\n![](${img})\n\nmore\n`, images, 0)
    expect(new Set(looked)).toEqual(new Set([img]))
    looked.length = 0
    const before = container.children[1]
    update(`text edited\n\n![](${img})\n\nmore\n`, images, 0)
    expect(container.children[1]).toBe(before)
    // The image block was not rendered again, yet its image was looked up.
    expect(looked).toEqual([img])
  })
})

describe('a block whose key is new but whose output is the same', () => {
  const video = 'https://example.com/demo.mp4'
  const withMedia = () => {
    const container = document.createElement('article')
    document.body.replaceChildren(container)
    const renderer = new BlockRenderer(container)
    return { container, update: (t: string, v = 0) => renderer.update(t, undefined, v, ['https:']) }
  }

  it('keeps a playing video when text is added after it', () => {
    const { container, update } = withMedia()
    update(video)
    const el = container.querySelector('video') as HTMLVideoElement
    el.currentTime = 30
    update(`${video}\n\nmore`)
    expect(container.querySelector('video')).toBe(el)
    expect(el.currentTime).toBe(30)
    expect(container.children).toHaveLength(2)
  })

  it('keeps a video in an image block when the images version changes', () => {
    const { container, update } = withMedia()
    update(`![demo](${video})\n\ntext`, 0)
    const el = container.querySelector('video') as HTMLVideoElement
    el.currentTime = 12
    update(`![demo](${video})\n\ntext`, 1)
    expect(container.querySelector('video')).toBe(el)
    expect(el.currentTime).toBe(12)
  })

  it('keeps the element and restamps its lines', () => {
    const { container, update } = withMedia()
    update('# a\n\ntext\n')
    const p = container.children[1] as Element
    // Appending after the last line changes that block's key, not its output.
    update('# a\n\ntext')
    expect(container.children[1]).toBe(p)
    update('new\n\n# a\n\ntext')
    expect(container.children[2]).toBe(p)
    expect(p.getAttribute('data-line')).toBe('4')
  })

  it('hands one old element to one block, identical blocks to separate elements', () => {
    const { container, update } = withMedia()
    update('same\n\nsame\n')
    const before = [...container.children]
    update('same\n\nsame')
    const after = [...container.children]
    expect(after).toEqual(before)
  })
})
