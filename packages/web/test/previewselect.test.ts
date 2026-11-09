// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { render } from '../src/preview.ts'
import { previewSelectionToSource } from '../src/previewselect.ts'

function mount(source: string): HTMLElement {
  const root = document.createElement('article')
  root.append(render(source))
  document.body.replaceChildren(root)
  return root
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

function map(source: string, from: string, to = from, nth: [number, number] = [0, 0]) {
  const root = mount(source)
  const r = previewSelectionToSource(root, select(root, from, to, nth), source)
  return r && source.slice(r.from, r.to)
}

describe('previewSelectionToSource', () => {
  it('maps a phrase of a paragraph', () => {
    expect(map('Hello world, how are you?', 'world, how')).toBe('world, how')
  })

  it('picks the occurrence that was selected', () => {
    const source = 'a cat and a cat and a cat\n'
    const root = mount(source)
    const range = select(root, 'cat')
    // The second "cat": start after the first one.
    const { node } = find(root, 'cat')
    const second = node.data.indexOf('cat', node.data.indexOf('cat') + 1)
    range.setStart(node, second)
    range.setEnd(node, second + 3)
    expect(previewSelectionToSource(root, range, source)).toEqual({ from: 12, to: 15 })
  })

  it('picks the right occurrence among blocks', () => {
    const source = 'one\n\nfoo bar\n\nfoo bar\n'
    const root = mount(source)
    const second = find(root, 'foo bar', 1)
    const range = document.createRange()
    range.setStart(second.node, 0)
    range.setEnd(second.node, 7)
    expect(previewSelectionToSource(root, range, source)).toEqual({ from: 14, to: 21 })
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

  it('spans two paragraphs', () => {
    const source = 'First paragraph text.\n\nSecond paragraph text.\n'
    expect(map(source, 'paragraph text.', 'Second paragraph')).toBe(
      'paragraph text.\n\nSecond paragraph',
    )
  })

  it('maps a soft-wrapped paragraph', () => {
    const source = 'The quick brown\nfox jumps over\n'
    expect(map(source, 'brown', 'fox')).toBe('brown\nfox')
  })

  it('maps text in a code block', () => {
    const source = '```js\nconst answer = 42\n```\n'
    expect(map(source, 'answer = 42')).toBe('answer = 42')
  })

  it('maps CJK text', () => {
    const source = '日本語の文章です。\n\n二つ目の段落です。\n'
    expect(map(source, '文章')).toBe('文章')
    expect(map(source, '段落')).toBe('段落')
  })

  it('returns null when it cannot be placed', () => {
    const source = 'some text\n'
    const root = mount(source)
    const range = select(root, 'some text')
    // The page shows something the source does not hold.
    expect(previewSelectionToSource(root, range, 'other words\n')).toBeNull()
  })

  it('returns null for a collapsed or outside selection, and for the frontmatter', () => {
    const source = '---\ntitle: Hi there\n---\n\nbody text\n'
    const root = mount(source)
    const body = find(root, 'body text')
    const collapsed = document.createRange()
    collapsed.setStart(body.node, 1)
    collapsed.collapse(true)
    expect(previewSelectionToSource(root, collapsed, source)).toBeNull()
    const outside = document.createRange()
    outside.selectNodeContents(document.body.appendChild(document.createElement('p')))
    expect(previewSelectionToSource(root, outside, source)).toBeNull()
    expect(previewSelectionToSource(root, select(root, 'Hi there'), source)).toBeNull()
    expect(map(source, 'body text')).toBe('body text')
  })

  it('never anchors on a link destination, alt text or fence info', () => {
    const link = 'See [the docs](https://example.com/docs) for docs.\n'
    const root = mount(link)
    const second = find(root, 'docs', 1)
    const range = document.createRange()
    range.setStart(second.node, second.at)
    range.setEnd(second.node, second.at + 4)
    expect(previewSelectionToSource(root, range, link)).toEqual({ from: 45, to: 49 })
    const image = '![cat](cat.png) a cat\n'
    const r2 = mount(image)
    const sel = select(r2, 'a cat')
    expect(previewSelectionToSource(r2, sel, image)).toEqual({ from: 16, to: 21 })
    const fence = '```python\nimport python\n```\n'
    const r3 = mount(fence)
    const f = select(r3, 'python')
    expect(previewSelectionToSource(r3, f, fence)).toEqual({ from: 17, to: 23 })
  })

  it('maps an escaped character as nothing guessed', () => {
    const source = '**bold** and 2 \\* 3\n'
    const root = mount(source)
    // The text around the escape is exact; the escape itself is not mapped.
    expect(map(source, 'and 2 ')).toBe('and 2')
    expect(map(source, ' 3')).toBe('3')
    expect(previewSelectionToSource(root, select(root, '*'), source)).toBeNull()
    const entity = 'fish &amp; chips\n'
    expect(map(entity, 'fish ')).toBe('fish')
    expect(map(entity, ' chips')).toBe('chips')
  })

  it('maps selections across markup by each boundary', () => {
    const source = 'Hello [world](https://x.org) and **x**\n'
    expect(map(source, 'world', 'x')).toBe('world](https://x.org) and **x')
  })

  it('maps across the soft wraps of a blockquote and a list item', () => {
    expect(map('> quoted line one\n> quoted line two\n', 'line one', 'line two')).toBe(
      'line one\n> quoted line two',
    )
    expect(map('- item one\n  continued here\n', 'one', 'continued')).toBe('one\n  continued')
  })

  it('maps table cells and repeated cell text', () => {
    const source = '| a | b |\n|---|---|\n| x | x |\n'
    const root = mount(source)
    const second = find(root, 'x', 1)
    const range = document.createRange()
    range.setStart(second.node, 0)
    range.setEnd(second.node, 1)
    expect(previewSelectionToSource(root, range, source)).toEqual({ from: 26, to: 27 })
  })

  it('moves a boundary between blocks to the nearest text', () => {
    const source = 'First para\n\nSecond para\n'
    const root = mount(source)
    const [p1, p2] = root.querySelectorAll('p')
    const range = document.createRange()
    range.setStart(p1 as Element, 0)
    range.setEnd(p2 as Element, 0)
    expect(previewSelectionToSource(root, range, source)).toEqual({ from: 0, to: 10 })
  })

  // Each case: [source, from text, to text, nth of each, the source text expected (null: not placed)].
  // None may give another range than the one the reader selected.
  const cases: [string, string, string, [number, number], string | null][] = [
    ['see [a b](u "t (x)") then a b end\n', 'then a b', 'then a b', [0, 0], 'then a b'],
    ['x [lbl](http://u "t)x") lbl tail\n', 'lbl tail', 'lbl tail', [0, 0], 'lbl tail'],
    ['x [lbl](http://u/(a)) lbl tail\n', 'lbl tail', 'lbl tail', [0, 0], 'lbl tail'],
    ['x [lbl](<a)b>) lbl tail\n', 'lbl tail', 'lbl tail', [0, 0], 'lbl tail'],
    ['[t](<u)> y) y\n', 'y) y', 'y) y', [0, 0], null],
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
    ['- [ ] todo\n- [x] done\n', 'done', 'done', [0, 0], null],
  ]
  it.each(cases)('never maps to another place: %j', (source, from, to, nth, want) => {
    const root = mount(source)
    let got: string | null = null
    try {
      const r = previewSelectionToSource(root, select(root, from, to, nth), source)
      got = r && source.slice(r.from, r.to)
    } catch {
      // The text is not in the page as written: nothing to select.
      return
    }
    expect(got === null || got === want).toBe(true)
    if (want !== null) expect(got).toBe(want)
  })

  it('keeps the same range for each repeat of a text that is also in a link', () => {
    const source = 'see [the docs](https://example.com/docs) for docs.\n'
    const root = mount(source)
    const one = find(root, 'docs', 0)
    const two = find(root, 'docs', 1)
    const pick = (n: { node: Text; at: number }) => {
      const r = document.createRange()
      r.setStart(n.node, n.at)
      r.setEnd(n.node, n.at + 4)
      return previewSelectionToSource(root, r, source)
    }
    expect(pick(one)).toEqual({ from: 9, to: 13 })
    expect(pick(two)).toEqual({ from: 45, to: 49 })
  })

  it('treats a run edge as no more than the selected text', () => {
    // Ends at the start of the next text: stops at the last selected character.
    expect(map('a *b*\n', 'a ', 'b', [0, 0])).toBe('a *b')
    const source = 'a *b*\n'
    const root = mount(source)
    const range = select(root, 'a ')
    const b = find(root, 'b')
    range.setEnd(b.node, 0)
    expect(previewSelectionToSource(root, range, source)).toEqual({ from: 0, to: 1 })
    // Starts at the end of a text: begins at the next selected character.
    const s2 = '*a* b\n'
    const r2 = mount(s2)
    const a = find(r2, 'a')
    const range2 = select(r2, ' b')
    range2.setStart(a.node, 1)
    expect(previewSelectionToSource(r2, range2, s2)).toEqual({ from: 4, to: 5 })
    // Up to the start of the next block.
    const s3 = '# foo\n\nbar\n'
    const r3 = mount(s3)
    const foo = find(r3, 'foo')
    const bar = find(r3, 'bar')
    const range3 = document.createRange()
    range3.setStart(foo.node, 0)
    range3.setEnd(bar.node, 0)
    expect(previewSelectionToSource(r3, range3, s3)).toEqual({ from: 2, to: 5 })
  })

  it('does not split a surrogate pair', () => {
    const source = 'a😀b\n'
    const root = mount(source)
    const a = find(root, 'a😀b')
    const range = document.createRange()
    range.setStart(a.node, 0)
    range.setEnd(a.node, 2)
    expect(previewSelectionToSource(root, range, source)).toEqual({ from: 0, to: 3 })
  })

  it('renders a long document in a time that does not grow with the square of it', () => {
    const lines = (n: number) =>
      Array.from({ length: n }, (_, i) => `| a${i} | b \\| ${i} |\n`).join('')
    const time = (n: number) => {
      const t = performance.now()
      render(`| a | b |\n|---|---|\n${lines(n)}`)
      return performance.now() - t
    }
    time(200)
    const small = Math.max(time(500), 1)
    // 4 times the rows: far under 16 times the time.
    expect(time(2000)).toBeLessThan(small * 12 + 50)
  })

  it('leaves tables inside a quote or a list unmapped, never at a neighbour', () => {
    for (const source of [
      '> | x | x |\n> |---|---|\n> | y | y |\n',
      '- | a | a |\n  |---|---|\n  | b | b |\n',
      '1. | a | a |\n   |---|---|\n   | b | b |\n',
      '> > | a | a |\n> > |---|---|\n> > | b | b |\n',
      '- x\n- | q | q |\n  |---|---|\n  | r | r |\n',
      '> p\n>\n> | a | a |\n> |---|---|\n> | b | b |\n',
    ]) {
      const root = mount(source)
      const cells = root.querySelectorAll('td, th')
      expect(cells.length).toBeGreaterThan(0)
      for (const cell of cells) {
        const range = document.createRange()
        range.selectNodeContents(cell)
        const got = previewSelectionToSource(root, range, source)
        expect(got).toBeNull()
      }
    }
  })

  it('tags blocks with their last line too', () => {
    const root = mount('a\nb\n\n- c\n- d\n')
    expect(
      [...root.querySelectorAll('[data-line]')].map((el) => [
        el.tagName,
        el.getAttribute('data-line'),
        el.getAttribute('data-line-end'),
      ]),
    ).toEqual([
      ['P', '0', '2'],
      ['UL', '3', '5'],
      ['LI', '3', '4'],
      ['LI', '4', '5'],
    ])
  })
})
