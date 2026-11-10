// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { BlockRenderer } from '../src/blockrender.ts'
import { loadEmbed } from '../src/preview.ts'
import { previewSelectionToSource } from '../src/previewselect.ts'
import corpus from './fixtures/preview-corpus.json'
import more from './fixtures/preview-positions-corpus.json'

const FUZZ = process.env.FUZZ === '1'

interface Page {
  container: HTMLElement
  renderer: BlockRenderer
  source: string
  update: (text: string) => void
}

function mount(source: string, options: { windowAbove?: number } = {}): Page {
  const container = document.createElement('article')
  document.body.replaceChildren(container)
  const renderer = new BlockRenderer(container, options)
  const page: Page = {
    container,
    renderer,
    source,
    update(text) {
      page.source = text
      renderer.update(text, undefined, 0, [])
    },
  }
  page.update(source)
  return page
}

/** The `nth` text node holding `needle`, and where in it. */
function find(root: Element, needle: string, nth = 0): { node: Text; at: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let seen = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = (n as Text).data.indexOf(needle)
    if (at >= 0 && seen++ === nth) return { node: n as Text, at }
  }
  throw new Error(`no text ${needle}`)
}

/** Selects from the start of `from` to the end of `to` (both texts of the preview). */
function select(root: Element, from: string, to = from, nth: [number, number] = [0, 0]): Range {
  const a = find(root, from, nth[0])
  const b = find(root, to, nth[1])
  const range = document.createRange()
  range.setStart(a.node, a.at)
  range.setEnd(b.node, b.at + to.length)
  return range
}

function pick(page: Page, range: Range) {
  return previewSelectionToSource(page.renderer, range, page.source)
}

function map(source: string, from: string, to = from, nth: [number, number] = [0, 0]) {
  const page = mount(source)
  const r = pick(page, select(page.container, from, to, nth))
  return r && source.slice(r.from, r.to)
}

// One Range for all: the document tracks every Range made until it is collected.
const shared = document.createRange()

function between(a: Node, i: number, b: Node, j: number): Range {
  shared.setStart(a, i)
  shared.setEnd(b, j)
  return shared
}

describe('previewSelectionToSource', () => {
  it('maps a phrase of a paragraph', () => {
    expect(map('Hello world, how are you?', 'world, how')).toBe('world, how')
  })

  it('picks the occurrence that was selected', () => {
    const source = 'a cat and a cat and a cat\n'
    const page = mount(source)
    const { node } = find(page.container, 'cat')
    const second = node.data.indexOf('cat', node.data.indexOf('cat') + 1)
    expect(pick(page, between(node, second, node, second + 3))).toEqual({ from: 12, to: 15 })
  })

  it('picks the right occurrence among blocks', () => {
    const source = 'one\n\nfoo bar\n\nfoo bar\n'
    const page = mount(source)
    const second = find(page.container, 'foo bar', 1)
    expect(pick(page, between(second.node, 0, second.node, 7))).toEqual({ from: 14, to: 21 })
  })

  it('spans bold, italic, links and inline code', () => {
    const source = 'Say **bold** and *it* and [a link](https://example.com) and `code` now\n'
    expect(map(source, 'Say ', ' now')).toBe(source.trimEnd())
    expect(map(source, 'bold')).toBe('bold')
    expect(map(source, 'a link')).toBe('a link')
    expect(map(source, 'code')).toBe('code')
    expect(map(source, 'bold', 'it')).toBe('bold** and *it')
  })

  it('maps list items and headings', () => {
    const source = '# Title here\n\n- first item\n- second item\n'
    expect(map(source, 'Title here')).toBe('Title here')
    expect(map(source, 'second item')).toBe('second item')
    expect(map(source, 'first item', 'second item')).toBe('first item\n- second item')
  })

  it('spans two paragraphs and several blocks', () => {
    const source = 'First paragraph text.\n\nSecond paragraph text.\n'
    expect(map(source, 'paragraph text.', 'Second paragraph')).toBe(
      'paragraph text.\n\nSecond paragraph',
    )
    const long = '# H\n\nalpha\n\n- one\n- two\n\n```\ncode\n```\n\nomega\n'
    expect(map(long, 'H', 'omega')).toBe(long.trimEnd().slice(2))
    expect(map(long, 'alpha', 'two')).toBe('alpha\n\n- one\n- two')
  })

  it('maps a soft-wrapped paragraph', () => {
    expect(map('The quick brown\nfox jumps over\n', 'brown', 'fox')).toBe('brown\nfox')
  })

  it('maps text in a code block', () => {
    expect(map('```js\nconst answer = 42\n```\n', 'answer = 42')).toBe('answer = 42')
    expect(map('    indented code\n', 'code')).toBe('code')
  })

  it('maps CJK text', () => {
    const source = '日本語の文章です。\n\n二つ目の段落です。\n'
    expect(map(source, '文章')).toBe('文章')
    expect(map(source, '段落')).toBe('段落')
  })

  it('returns null when the source is not what the page shows', () => {
    const page = mount('some text\n')
    const range = select(page.container, 'some text')
    expect(previewSelectionToSource(page.renderer, range, 'other words\n')).toBeNull()
  })

  it('returns null for a stale render: the source changed, the renderer not yet', () => {
    const source = 'first\n\nsecond block\n\nthird\n'
    const page = mount(source)
    const range = select(page.container, 'second block')
    expect(pick(page, range)).toEqual({ from: 7, to: 19 })
    // Text above moved the block; the same length elsewhere changes what is there.
    for (const stale of ['new line\n\n' + source, source.replace('second', 'SECOND'), '']) {
      expect(previewSelectionToSource(page.renderer, range, stale)).toBeNull()
    }
    // Once the renderer has it, it maps again (to where the block is now).
    page.update(`new line\n\n${source}`)
    expect(pick(page, select(page.container, 'second block'))).toEqual({ from: 17, to: 29 })
  })

  it('returns null for a collapsed or outside selection, and for the frontmatter', () => {
    const source = '---\ntitle: Hi there\n---\n\nbody text\n'
    const page = mount(source)
    const body = find(page.container, 'body text')
    const collapsed = between(body.node, 1, body.node, 1)
    expect(pick(page, collapsed)).toBeNull()
    const outside = document.createRange()
    outside.selectNodeContents(document.body.appendChild(document.createElement('p')))
    expect(pick(page, outside)).toBeNull()
    expect(pick(page, select(page.container, 'Hi there'))).toBeNull()
    expect(map(source, 'body text')).toBe('body text')
  })

  it('never anchors on a link destination, alt text or fence info', () => {
    const link = 'See [the docs](https://example.com/docs) for docs.\n'
    const page = mount(link)
    const second = find(page.container, 'docs', 1)
    expect(pick(page, between(second.node, second.at, second.node, second.at + 4))).toEqual({
      from: 45,
      to: 49,
    })
    const image = '![cat](cat.png) a cat\n'
    const p2 = mount(image)
    expect(pick(p2, select(p2.container, 'a cat'))).toEqual({ from: 16, to: 21 })
    const fence = '```python\nimport python\n```\n'
    const p3 = mount(fence)
    expect(pick(p3, select(p3.container, 'python'))).toEqual({ from: 17, to: 23 })
  })

  it('does not place an escape or an entity, and maps the text around them', () => {
    const source = '**bold** and 2 \\* 3\n'
    const page = mount(source)
    expect(map(source, 'and 2 ')).toBe('and 2')
    expect(map(source, ' 3')).toBe('3')
    expect(pick(page, select(page.container, '*'))).toBeNull()
    const entity = 'fish &amp; chips\n'
    expect(map(entity, 'fish ')).toBe('fish')
    expect(map(entity, ' chips')).toBe('chips')
  })

  it('maps selections across markup by each boundary', () => {
    expect(map('Hello [world](https://x.org) and **x**\n', 'world', 'x')).toBe(
      'world](https://x.org) and **x',
    )
  })

  it('maps across the soft wraps of a blockquote and a list item', () => {
    expect(map('> quoted line one\n> quoted line two\n', 'line one', 'line two')).toBe(
      'line one\n> quoted line two',
    )
    expect(map('- item one\n  continued here\n', 'one', 'continued')).toBe('one\n  continued')
  })

  it('maps table cells and repeated cell text', () => {
    const source = '| a | b |\n|---|---|\n| x | x |\n'
    const page = mount(source)
    const second = find(page.container, 'x', 1)
    expect(pick(page, between(second.node, 0, second.node, 1))).toEqual({ from: 26, to: 27 })
  })

  it('moves a boundary between blocks to the nearest text', () => {
    const source = 'First para\n\nSecond para\n'
    const page = mount(source)
    const [p1, p2] = page.container.querySelectorAll('p')
    expect(pick(page, between(p1 as Element, 0, p2 as Element, 0))).toEqual({ from: 0, to: 10 })
    // To the end of the last element: all of its text.
    const end = p2 as Element
    expect(pick(page, between(p1 as Element, 0, end, end.childNodes.length))).toEqual({
      from: 0,
      to: 23,
    })
  })

  // Each case: [source, from text, to text, nth of each, the source text expected (null: not placed)].
  // None may give another range than the one the reader selected.
  const cases: [string, string, string, [number, number], string | null][] = [
    ['see [a b](u "t (x)") then a b end\n', 'then a b', 'then a b', [0, 0], 'then a b'],
    ['x [lbl](http://u "t)x") lbl tail\n', 'lbl tail', 'lbl tail', [0, 0], 'lbl tail'],
    ['x [lbl](http://u/(a)) lbl tail\n', 'lbl tail', 'lbl tail', [0, 0], 'lbl tail'],
    ['x [lbl](<a)b>) lbl tail\n', 'lbl tail', 'lbl tail', [0, 0], 'lbl tail'],
    ['[t](<u)> y) y\n', 'y) y', 'y) y', [0, 0], 'y) y'],
    ['x [foo][r] foo\n\n[r]: /u "foo"\n', 'foo', 'foo', [1, 1], 'foo'],
    ['x [foo][a\\]b] foo\n\n[a\\]b]: /u\n', 'foo', 'foo', [1, 1], 'foo'],
    ['[foo](x y) z\n(x y) z\n\n[foo]: /u\n', '(x y) z', '(x y) z', [1, 1], '(x y) z'],
    ['![alt](i.png) alt\n', ' alt', ' alt', [0, 0], 'alt'],
    ['---\ntitle: x\n---\n\nx\n', 'x', 'x', [1, 1], 'x'],
    ['x `a\nb` a b\n', 'a b', 'a b', [0, 0], null],
    ['x ` a ` a\n', 'a', 'a', [0, 0], null],
    ['| x \\| y | x | y |\n|---|---|---|\n', 'y', 'y', [0, 0], null],
    ['| a | b |\n|---|---|\n| x \\| y | z |\n', 'z', 'z', [0, 0], 'z'],
    [
      '<https://ex.com/%41> https://ex.com/A\n',
      'https://ex.com/A',
      'https://ex.com/A',
      [0, 0],
      null,
    ],
    ['a \\*b\\* *b*\n', 'b', 'b', [1, 1], 'b'],
    ['a😀 **😀b** 😀b\n', '😀b', '😀b', [1, 1], '😀b'],
    ['a 2 * 3 b * c\n', 'b', 'b', [0, 0], 'b'],
    ['snake_case_name here\n', 'case', 'case', [0, 0], 'case'],
    ['- [ ] todo\n- [x] done\n', 'done', 'done', [0, 0], 'done'],
  ]
  it.each(cases)('never maps to another place: %j', (source, from, to, nth, want) => {
    const page = mount(source)
    let got: string | null = null
    try {
      const r = pick(page, select(page.container, from, to, nth))
      got = r && source.slice(r.from, r.to)
    } catch {
      // The text is not in the page as written: nothing to select.
      return
    }
    expect(got === null || got === want).toBe(true)
    if (want !== null) expect(got).toBe(want)
  })

  it('keeps the same range for each repeat of a text that is also in a link', () => {
    const page = mount('see [the docs](https://example.com/docs) for docs.\n')
    const at = (n: number) => {
      const d = find(page.container, 'docs', n)
      return pick(page, between(d.node, d.at, d.node, d.at + 4))
    }
    expect(at(0)).toEqual({ from: 9, to: 13 })
    expect(at(1)).toEqual({ from: 45, to: 49 })
  })

  it('treats a run edge as no more than the selected text', () => {
    // Ends at the start of the next text: stops at the last selected character.
    expect(map('a *b*\n', 'a ', 'b', [0, 0])).toBe('a *b')
    const page = mount('a *b*\n')
    const b = find(page.container, 'b')
    const range = select(page.container, 'a ')
    range.setEnd(b.node, 0)
    expect(pick(page, range)).toEqual({ from: 0, to: 1 })
    // Starts at the end of a text: begins at the next selected character.
    const p2 = mount('*a* b\n')
    const a = find(p2.container, 'a')
    const range2 = select(p2.container, ' b')
    range2.setStart(a.node, 1)
    expect(pick(p2, range2)).toEqual({ from: 4, to: 5 })
    // Up to the start of the next block.
    const p3 = mount('# foo\n\nbar\n')
    const foo = find(p3.container, 'foo')
    const bar = find(p3.container, 'bar')
    expect(pick(p3, between(foo.node, 0, bar.node, 0))).toEqual({ from: 2, to: 5 })
    // From the end of one block.
    const p4 = mount('# foo\n\nbar\n')
    const foo4 = find(p4.container, 'foo')
    const bar4 = find(p4.container, 'bar')
    expect(pick(p4, between(foo4.node, 3, bar4.node, 3))).toEqual({ from: 7, to: 10 })
  })

  it('does not split a surrogate pair', () => {
    const page = mount('a😀b\n')
    const a = find(page.container, 'a😀b')
    expect(pick(page, between(a.node, 0, a.node, 2))).toEqual({ from: 0, to: 3 })
    expect(pick(page, between(a.node, 2, a.node, 4))).toEqual({ from: 1, to: 4 })
  })

  it('returns null when a boundary is in a run that is not the source as shown', () => {
    for (const source of ['x &amp; y\n', 'x \\* y\n', '[a](u)\n']) {
      const page = mount(source)
      const text = page.container.textContent ?? ''
      const t = find(page.container, text.trim().slice(0, 1))
      const whole = between(t.node, 0, t.node, t.node.data.length)
      const r = pick(page, whole)
      // Whatever is returned, the text of its ends is what was selected.
      if (r) {
        expect(source.slice(r.from, r.to).startsWith(text.trim()[0] as string)).toBe(true)
        expect(source.slice(r.from, r.to).endsWith(text.trim().slice(-1))).toBe(true)
      }
    }
    const page = mount('x &amp; y\n')
    expect(pick(page, select(page.container, '& y'))).toBeNull()
    expect(pick(page, select(page.container, 'x &'))).toBeNull()
  })

  it('maps with block-relative lines and a windowed parse, in blocks far from the start', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `para ${i} with *em${i}* and [l${i}](u)\n`)
    const source = rows.join('\n')
    for (const windowAbove of [0, Number.POSITIVE_INFINITY]) {
      const page = mount(source, { windowAbove })
      const edit = `intro\n\n${source}`
      page.update(edit)
      for (const i of [0, 7, 31, 59]) {
        const range = select(page.container, `em${i}`, `l${i}`)
        const r = pick(page, range)
        expect(r && edit.slice(r.from, r.to), `${windowAbove} ${i}`).toBe(`em${i}* and [l${i}`)
      }
      const a = select(page.container, 'em3', 'em4')
      const r = pick(page, a)
      expect(r && edit.slice(r.from, r.to)).toBe(`em3* and [l3](u)\n\npara 4 with *em4`)
    }
  })

  it('returns null in a block that holds a loaded embed, also after a patch kept it', () => {
    const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    const source = `- note one\n- ${YT}\n\noutro text\n`
    const page = mount(source)
    const placeholder = page.container.querySelector('.embed') as HTMLElement
    const text = (src: string, needle: string) => {
      const r = pick(page, select(page.container, needle))
      return r && src.slice(r.from, r.to)
    }
    // Before the player is loaded the block is what it renders to.
    expect(text(source, 'note one')).toBe('note one')
    expect(loadEmbed(placeholder)).not.toBeNull()
    // The loaded player replaced the placeholder's text: the twin is not the live block.
    expect(text(source, 'note one')).toBeNull()
    // The list is rendered again with another first item; the player stays in the old element.
    const edited = `- note TWO\n- ${YT}\n\noutro text\n`
    page.update(edited)
    expect(page.container.querySelector('.embed')).toBe(placeholder)
    expect(placeholder.querySelector('iframe')).not.toBeNull()
    expect(text(edited, 'note TWO')).toBeNull()
    // The other blocks are not affected.
    expect(text(edited, 'outro text')).toBe('outro text')
  })

  it('returns null in a block whose live text is not the twin text', () => {
    const page = mount('a *b* c\n\nz\n')
    const text = find(page.container, 'a ')
    const range = between(text.node, 0, text.node, 2)
    expect(pick(page, range)).toEqual({ from: 0, to: 1 })
    // Something changes the live text (a script, an extension): the block is not trusted.
    const live = page.container.querySelector('p') as HTMLElement
    live.append(' extra')
    expect(pick(page, range)).toBeNull()
  })
})

describe('a render that is not the text given', () => {
  it('returns null unless the source is the text the renderer last showed', () => {
    const s1 = 'ab\n\nab\n'
    const s2 = 'zz\n\nab\n\nab\n'
    const page = mount(s1)
    const range = select(page.container, 'ab', 'ab', [1, 1])
    expect(pick(page, range)).toEqual({ from: 4, to: 6 })
    // Same text in another string: fine.
    expect(previewSelectionToSource(page.renderer, range, s1.split('').join(''))).toEqual({
      from: 4,
      to: 6,
    })
    // A newer text with an identical block at the old offset is not the render's.
    expect(previewSelectionToSource(page.renderer, range, s2)).toBeNull()
    // And the other way round.
    const page2 = mount(s2)
    const r2 = select(page2.container, 'ab', 'ab', [1, 1])
    expect(pick(page2, r2)).toEqual({ from: 8, to: 10 })
    expect(previewSelectionToSource(page2.renderer, r2, s1)).toBeNull()
    page2.update(s1)
    expect(previewSelectionToSource(page2.renderer, select(page2.container, 'ab'), s1)).toEqual({
      from: 0,
      to: 2,
    })
  })
})

describe('a boundary between the blocks', () => {
  const source = 'one\n\ntwo *x*\n\nthree\n'

  it('maps a select-all to the whole text', () => {
    const page = mount(source)
    const range = document.createRange()
    range.selectNodeContents(page.container)
    expect(pick(page, range)).toEqual({ from: 0, to: source.length - 1 })
  })

  it('maps a drag that ends or starts in the gap to the block next to it', () => {
    const page = mount(source)
    const c = page.container
    const kids = [...c.childNodes]
    const second = kids.findIndex((n) => n.textContent?.startsWith('two'))
    const one = find(c, 'one')
    expect(pick(page, between(one.node, 0, c, second))).toEqual({ from: 0, to: 3 })
    expect(pick(page, between(one.node, 0, c, second + 1))).toEqual({ from: 0, to: 11 })
    const three = find(c, 'three')
    expect(pick(page, between(c, second + 1, three.node, 5))).toEqual({ from: 14, to: 19 })
    // Only a gap, or after the last block: nothing selected.
    expect(pick(page, between(c, second, c, second + 1))).toEqual({ from: 5, to: 11 })
    expect(pick(page, between(c, c.childNodes.length, c, c.childNodes.length))).toBeNull()
    expect(pick(page, between(c, 0, c, 0))).toBeNull()
  })
})

describe('the twin is kept', () => {
  it('is not rendered again for a second selection, and is after an edit', () => {
    const container = document.createElement('article')
    document.body.replaceChildren(container)
    let rendered = 0
    const renderer = new BlockRenderer(container, { decorate: () => rendered++ })
    const first = 'alpha beta\n\ngamma\n'
    renderer.update(first, undefined, 0, [])
    const page = { container, renderer, source: first } as Page
    const live = rendered
    expect(pick(page, select(container, 'alpha'))).toEqual({ from: 0, to: 5 })
    const once = rendered
    expect(once).toBeGreaterThan(live)
    expect(pick(page, select(container, 'beta'))).toEqual({ from: 6, to: 10 })
    expect(pick(page, select(container, 'alpha', 'beta'))).toEqual({ from: 0, to: 10 })
    expect(rendered).toBe(once)
    // Another block has its own twin.
    expect(pick(page, select(container, 'gamma'))).toEqual({ from: 12, to: 17 })
    expect(rendered).toBeGreaterThan(once)
    // An edit of the block gives a new twin; the other block keeps its one.
    const next = 'alpha BETA\n\ngamma\n'
    renderer.update(next, undefined, 0, [])
    page.source = next
    const before = rendered
    expect(pick(page, select(container, 'BETA'))).toEqual({ from: 6, to: 10 })
    const after = rendered
    expect(after).toBeGreaterThan(before)
    expect(pick(page, select(container, 'BETA'))).toEqual({ from: 6, to: 10 })
    expect(rendered).toBe(after)
  })
})

// ---------------------------------------------------------------------------
// The selections of every kind, checked against the text itself: the source is
// changed at the offset claimed for a visible character, and exactly that
// character of the page must change.

function texts(root: Element): Text[] {
  const out: Text[] = []
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text)
  return out
}

/** One code unit changed so that the character differs but its kind does not; null if none. */
function mut(s: string, i: number): string | null {
  const c = s.charCodeAt(i)
  let d: number | null = null
  if (c >= 65 && c <= 90) d = c + 32
  else if (c >= 97 && c <= 122) d = c - 32
  else if (c >= 48 && c <= 57) d = c === 57 ? 48 : c + 1
  else if (c >= 0x4e00 && c < 0x9fff) d = c + 1
  else if (c >= 0x3041 && c < 0x3094) d = c + 1
  else if (c >= 0xdc00 && c < 0xdfff) d = c + 1
  else if (c >= 0xd800 && c <= 0xdbff) return mut(s, i + 1)
  if (d === null) return null
  return s.slice(0, i) + String.fromCharCode(d) + s.slice(i + 1)
}

// The text of another source is read through one renderer that is not discarded: a page
// for each of the many mutated sources would pile up in the document.
const scratch = document.createElement('article')
const scratchRenderer = new BlockRenderer(scratch)

function pageText(src: string): string {
  scratchRenderer.reset()
  scratchRenderer.update(src, undefined, 0, [])
  return scratch.textContent ?? ''
}

/** The index in the page text of the character at `src[off]`, or why that is not known. */
function visibleAt(src: string, off: number, T: string): number | 'skip' | 'none' | 'multi' {
  const m = mut(src, off)
  if (m === null) return 'skip'
  const T2 = pageText(m)
  if (T2.length !== T.length) return 'multi'
  const d: number[] = []
  for (let i = 0; i < T.length; i++) if (T[i] !== T2[i]) d.push(i)
  if (d.length === 0) return 'none'
  if (d.length > 2 || (d.length === 2 && (d[1] as number) !== (d[0] as number) + 1)) return 'multi'
  return d[0] as number
}

const isHi = (s: string, i: number) => {
  const c = s.charCodeAt(i)
  return c >= 0xd800 && c <= 0xdbff
}
const isLow = (s: string, i: number) => {
  const c = s.charCodeAt(i)
  return c >= 0xdc00 && c <= 0xdfff
}
const mutable = (s: string, i: number) => mut(s, i) !== null

let mapped = 0

/** Checks one selection of `page`; returns what is wrong with its answer, if anything. */
function check(page: Page, T: string, sg: number, eg: number, range: Range): string[] {
  const src = page.source
  const bad: string[] = []
  let r: ReturnType<typeof pick>
  try {
    r = pick(page, range)
  } catch (e) {
    return [`crash ${(e as Error).message}`]
  }
  if (!r) return bad
  mapped++
  const sel = T.slice(sg, eg)
  const fg = sg + sel.length - sel.trimStart().length
  const lg = sg + sel.trimEnd().length - 1
  const desc = `sel=${JSON.stringify(sel)} got=${JSON.stringify(src.slice(r.from, r.to))}@${r.from}-${r.to}`
  if (fg > lg) return [`blank ${desc}`]
  // A boundary in the middle of a surrogate pair takes the whole character.
  const fs = isLow(T, fg) && isHi(T, fg - 1) ? fg - 1 : fg
  const le = isHi(T, lg) ? lg + 1 : lg
  const ends = [
    [r.from, fs + (isHi(T, fs) ? 1 : 0), 'from'],
    [r.to - 1, le, 'to'],
  ] as const
  for (const [off, want, tag] of ends) {
    const v = mutable(src, off) ? visibleAt(src, off, T) : 'skip'
    if (v !== 'skip' && v !== 'multi' && v !== want)
      bad.push(`${tag} ${desc} at ${off}: ${v} want ${want}`)
  }
  // The first and the last character are what the selection starts and ends with.
  if (src[r.from] !== T[fs] || src[r.to - 1] !== T[le]) bad.push(`ends ${desc}`)
  // Non-blank characters just outside the selection are not what the range starts or ends with.
  for (const [g2, off] of [
    [fs - 1, r.from],
    [le + 1, r.to - 1],
  ] as const) {
    if (g2 >= 0 && g2 < T.length && mutable(T, g2) && mutable(src, off) && src[off] === T[g2]) {
      if (visibleAt(src, off, T) === g2) bad.push(`outside ${desc} at ${off}`)
    }
  }
  return bad
}

/** Every character alone, and sampled pairs of positions, of the document. */
function fuzzDoc(src: string, pairs: number, every: number, name: string): string[] {
  const page = mount(src)
  const T = page.container.textContent ?? ''
  const nodes = texts(page.container)
  const starts: number[] = []
  let g = 0
  for (const n of nodes) {
    starts.push(g)
    g += n.data.length
  }
  const bad: string[] = []
  const note = (list: string[]) => {
    for (const m of list) bad.push(`${name}: ${m}`)
  }
  let count = 0
  for (const [i, n] of nodes.entries()) {
    for (let k = 0; k < n.data.length; k++) {
      if (/\s/.test(n.data[k] as string) || count++ % every) continue
      const sg = (starts[i] as number) + k
      note(check(page, T, sg, sg + 1, between(n, k, n, k + 1)))
    }
  }
  const pos: [Text, number, number][] = []
  for (const [i, n] of nodes.entries()) {
    for (let k = 0; k <= n.data.length; k++) pos.push([n, k, (starts[i] as number) + k])
  }
  const step = Math.max(1, Math.floor(pos.length / pairs))
  for (let a = 0; a < pos.length; a += step) {
    for (let b = a + 1; b < pos.length; b += step) {
      const [sn, so, sg] = pos[a] as [Text, number, number]
      const [en, eo, eg] = pos[b] as [Text, number, number]
      if (eg > sg) note(check(page, T, sg, eg, between(sn, so, en, eo)))
    }
  }
  return bad
}

describe('selections, character by character', () => {
  const docs = [...(corpus as [string, string][]), ...(more as [string, string][])]
  // Cheap by default: a sample of the documents. A longer run: FUZZ=1.
  const chosen = FUZZ ? docs : docs.filter((_, i) => i % 12 === 0)

  it(
    'cover exactly the selected characters, for every document of the corpus',
    () => {
      const bad: string[] = []
      for (const [name, src] of chosen) {
        bad.push(...fuzzDoc(src, FUZZ ? 40 : 10, FUZZ ? 1 : 3, name))
      }
      expect(bad.slice(0, 20)).toEqual([])
      // The check is not vacuous: many selections were placed.
      expect(mapped).toBeGreaterThan(500)
    },
    FUZZ ? 600_000 : 60_000,
  )

  it(
    'cover exactly the selected characters after repeated punctuation',
    () => {
      const bad: string[] = []
      for (const src of [
        '[[a](u)\n',
        '<<https://x.y> w\n',
        '&&amp; z\n',
        '!![a](u)\n',
        'x\n[[[b](u) y\n',
      ]) {
        bad.push(...fuzzDoc(src, FUZZ ? 40 : 30, 1, JSON.stringify(src)))
      }
      expect(bad.slice(0, 20)).toEqual([])
    },
    FUZZ ? 600_000 : 60_000,
  )

  it(
    'cover exactly the selected characters in generated documents',
    () => {
      let seed = 11
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return (seed >> 8) % n
      }
      const parts = [
        'plain words here',
        '*em* and **strong**',
        '[link text](https://x.y/z "t")',
        '`code` span',
        '&amp; entity',
        'escaped \\* star',
        '日本語 text',
        'emoji 😀 mark',
        '![img](i.png) alt',
        '~~strike~~ end',
      ]
      const wraps = ['', '- ', '> ', '1. ', '# ']
      const bad: string[] = []
      for (let doc = FUZZ ? 40 : 6; doc > 0; doc--) {
        let src = ''
        for (let blocks = 1 + rnd(4); blocks > 0; blocks--) {
          const wrap = wraps[rnd(wraps.length)] as string
          const line = Array.from({ length: 1 + rnd(3) }, () => parts[rnd(parts.length)]).join(' ')
          src += `${wrap}${line}\n\n`
        }
        bad.push(...fuzzDoc(src, FUZZ ? 30 : 8, FUZZ ? 1 : 4, JSON.stringify(src)))
      }
      expect(bad.slice(0, 20)).toEqual([])
    },
    FUZZ ? 600_000 : 60_000,
  )
})
