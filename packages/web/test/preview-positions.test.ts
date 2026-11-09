// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { BlockRenderer } from '../src/blockrender.ts'
import { type Block, type BlockEnv, parseBlocks, renderBlock } from '../src/preview.ts'
import corpus from './fixtures/preview-corpus.json'
import more from './fixtures/preview-positions-corpus.json'

const FUZZ = process.env.FUZZ === '1'
const docs: [string, string][] = [
  ...(corpus as [string, string][]),
  ...(more as [string, string][]),
]

const MIXED = [
  '---',
  'title: t',
  '---',
  '',
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
  '| a | b |',
  '|---|---|',
  '| 1 | `2` |',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  '    indented code',
  '',
  'https://ex.com/a',
  '',
].join('\n')

function envOf(references: BlockEnv['references'], spans?: boolean): BlockEnv {
  return { media: [], breaks: false, references, spans }
}

/** Every element of `roots` that carries a position. */
function marked(roots: Element[]): Element[] {
  return roots
    .flatMap((r) => [r, ...r.querySelectorAll('*')])
    .filter((e) => e.hasAttribute('data-src'))
}

let checked = 0

// Each run's text is the block's source at its offset, exactly.
function expectRuns(block: Block, roots: Element[], name: string): void {
  for (const el of marked(roots)) {
    const at = Number(el.getAttribute('data-src'))
    const text = el.textContent ?? ''
    const slice = block.src.slice(at, at + text.length)
    if (slice !== text) {
      expect.fail(
        `${name}: run ${JSON.stringify(text)} at ${at} is ${JSON.stringify(slice)} in ${JSON.stringify(block.src)}`,
      )
    }
    checked++
  }
}

const strip = (html: string) =>
  html.replace(/<span data-src="\d+">([^<]*)<\/span>/g, '$1').replace(/ data-src="\d+"/g, '')

const html = (roots: Element[]) => roots.map((r) => r.outerHTML).join('')
const text = (roots: Element[]) => roots.map((r) => r.textContent).join('')

describe('positions in a block render', () => {
  it('every run is its block source, run by run, for every corpus document', () => {
    for (const [name, src] of [['mixed', MIXED] as [string, string], ...docs]) {
      const { blocks, references } = parseBlocks(src)
      for (const block of blocks) {
        expectRuns(block, renderBlock(block, envOf(references, true)), name)
      }
    }
    expect(checked).toBeGreaterThan(500)
  })

  it('is the same render, with the positions taken out, as without', () => {
    for (const [name, src] of [['mixed', MIXED] as [string, string], ...docs]) {
      const { blocks, references } = parseBlocks(src)
      for (const block of blocks) {
        const off = html(renderBlock(block, envOf(references)))
        const on = html(renderBlock(block, envOf(references, true)))
        expect(off, name).not.toContain('data-src')
        expect(html(renderBlock(block, envOf(references, false))), name).toBe(off)
        expect(strip(on), name).toBe(off)
        // The positions of one render never leak into the next.
        expect(html(renderBlock(block, envOf(references))), name).toBe(off)
      }
    }
  })

  it('maps nothing in a block with a carriage return or a NUL', () => {
    for (const src of [
      'a\r\n\r\nfoo *bar*\r\nbaz\r\n',
      'a\rb\r\rc\n',
      'a\u0000b c\n',
      '# h\r\n\r\n```\r\ncode\r\n```\r\n\r\n| a |\r\n|---|\r\n| b |\r\n',
    ]) {
      const { blocks, references } = parseBlocks(src)
      expect(blocks.some((b) => b.unmapped)).toBe(true)
      for (const block of blocks) {
        const roots = renderBlock(block, envOf(references, true))
        if (block.unmapped) expect(marked(roots)).toEqual([])
      }
    }
  })

  it('leaves only the block with the line ending unmapped', () => {
    const src = 'plain *one*\n\ncrlf *two*\r\nsecond\r\n\r\nplain *three*\n'
    const { blocks, references } = parseBlocks(src)
    const counts = blocks.map((b) => marked(renderBlock(b, envOf(references, true))).length)
    expect(blocks.map((b) => b.unmapped)).toEqual([false, true, false])
    expect(counts.map((n) => n > 0)).toEqual([true, false, true])
  })

  it('maps the cells of a table, and nothing in a table in a quote or a list', () => {
    const cells = (src: string) => {
      const { blocks, references } = parseBlocks(src)
      return blocks.flatMap((b) => marked(renderBlock(b, envOf(references, true))))
    }
    expect(cells('| a | b |\n|---|---|\n| c | d |\n').length).toBe(4)
    expect(cells('> | a | b |\n> |---|---|\n> | c | d |\n')).toEqual([])
    expect(cells('- | a | b |\n  |---|---|\n  | c | d |\n')).toEqual([])
    expect(cells('1. | a | a |\n   |---|---|\n   | b | b |\n')).toEqual([])
  })

  it('leaves out what is not the source as it is shown', () => {
    const run = (src: string) => {
      const { blocks, references } = parseBlocks(src)
      return blocks.flatMap((b) =>
        marked(renderBlock(b, envOf(references, true))).map((e) => e.textContent),
      )
    }
    const runs = run('a &amp; b \\*c\\* https://ex.com/x <https://y.z>\n')
    expect(runs).not.toContain('&')
    expect(runs.join('')).not.toContain('https://ex.com/x')
    expect(run('x **bold** y\n')).toContain('bold')
  })
})

function mount(src: string): { renderer: BlockRenderer; container: HTMLElement } {
  const container = document.createElement('div')
  const renderer = new BlockRenderer(container)
  renderer.update(src, undefined, 0, [])
  return { renderer, container }
}

describe('BlockRenderer.twin and blockAt', () => {
  it('has the live text, and the block offset, for every block of every document', () => {
    for (const [name, src] of [['mixed', MIXED] as [string, string], ...docs]) {
      const { renderer, container } = mount(src)
      const before = container.innerHTML
      const live = new Map<Block, Element[]>()
      for (const root of container.children) {
        const hit = renderer.blockAt(root)
        expect(hit?.element, name).toBe(root)
        const list = live.get((hit as { block: Block }).block)
        if (list) list.push(root)
        else live.set((hit as { block: Block }).block, [root])
      }
      let i = 0
      for (const [block, roots] of live) {
        const twin = renderer.twin(roots[0] as Element)
        expect(twin?.block, name).toBe(block)
        expect(twin?.offset, name).toBe(block.offset)
        expect(src.slice(block.offset, block.offset + block.src.length), name).toBe(block.src)
        expect(text(twin?.elements ?? []), name).toBe(text(roots))
        expect(twin?.elements[0]?.isConnected).toBe(false)
        expectRuns(block, twin?.elements ?? [], name)
        i++
      }
      // blocks that render to nothing (definitions) have no root, so the count can be less
      expect(i).toBeLessThanOrEqual(parseBlocks(src).blocks.length)
      expect(container.innerHTML, name).toBe(before)
      expect(container.querySelector('[data-src]')).toBeNull()
    }
  })

  it('finds the block of a node deep inside it, and of nothing else', () => {
    const { renderer, container } = mount('# h\n\npara with **bold** text\n')
    const bold = container.querySelector('strong')?.firstChild as Node
    expect(renderer.blockAt(bold)?.element).toBe(container.children[1])
    expect(renderer.blockAt(document.createElement('p'))).toBeNull()
    expect(renderer.twin(5)).toBeNull()
    expect(renderer.twin(document.createElement('p'))).toBeNull()
  })

  it('follows the text after edits: kept blocks have their new offset', () => {
    const { renderer, container } = mount('first *a*\n\nsecond *b*\n')
    renderer.update('new line\n\nfirst *a*\n\nsecond *b*\n', undefined, 0, [])
    const second = container.children[2] as Element
    const twin = renderer.twin(second)
    expect(twin?.offset).toBe('new line\n\nfirst *a*\n\n'.length)
    expect(text(twin?.elements ?? [])).toBe(second.textContent)
    const at = Number(twin?.elements[0]?.querySelector('[data-src]')?.getAttribute('data-src'))
    expect((twin?.block.src ?? '').slice(at, at + 6)).toBe('second')
  })

  it('applies the decorate function to the twin as to the live block', () => {
    const container = document.createElement('div')
    const renderer = new BlockRenderer(container, {
      decorate: (root) => root.setAttribute('data-x', '1'),
    })
    renderer.update('a *b*\n', undefined, 0, [])
    expect(renderer.twin(0)?.elements[0]?.getAttribute('data-x')).toBe('1')
  })
})

describe('positions over edited corpus documents', () => {
  it(
    'hold on random edits and joins of the documents',
    () => {
      let seed = 11
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed % n
      }
      const trials = FUZZ ? 1500 : 40
      const ops = ['x', '\n', '', 'ab ', '*', '|', '\n\n', '> ', '- ', '`', '\\', '&amp;', '\r\n']
      for (let t = 0; t < trials; t++) {
        let src = [0, 1, 2].map(() => (docs[rnd(docs.length)] as [string, string])[1]).join('')
        for (let e = 0; e <= rnd(3); e++) {
          const at = rnd(src.length + 1)
          src = src.slice(0, at) + ops[rnd(ops.length)] + src.slice(at + rnd(3))
        }
        const { renderer, container } = mount(src)
        for (const root of container.children) {
          const twin = renderer.twin(root)
          const roots = [...container.children].filter(
            (r) => renderer.blockAt(r)?.block === twin?.block,
          )
          expect(text(twin?.elements ?? []), JSON.stringify(src)).toBe(text(roots))
          expectRuns(twin?.block as Block, twin?.elements ?? [], JSON.stringify(src))
        }
      }
    },
    FUZZ ? 600_000 : 20_000,
  )
})

/** The runs of a block's twin: text, offset, and where its first character is in the block's text. */
function runsOf(src: string): { text: string; at: number; index: number; block: Block }[] {
  const { blocks, references } = parseBlocks(src)
  const out: { text: string; at: number; index: number; block: Block }[] = []
  for (const block of blocks) {
    const roots = renderBlock(block, envOf(references, true))
    const texts: Text[] = []
    for (const root of roots) {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) texts.push(n as Text)
    }
    for (const el of marked(roots)) {
      const first = texts.find((t) => el.contains(t))
      if (!first) continue
      const index = texts.slice(0, texts.indexOf(first)).reduce((n, t) => n + t.data.length, 0)
      out.push({
        text: el.textContent ?? '',
        at: Number(el.getAttribute('data-src')),
        index,
        block,
      })
    }
  }
  return out
}

function visible(src: string): string {
  const { blocks, references } = parseBlocks(src)
  return blocks.map((b) => text(renderBlock(b, envOf(references)))).join('')
}

const CONSTRUCTS: [string, string][] = [
  ['[', '[a](u)'],
  ['[', '[a] b'],
  ['!', '![Img](i)'],
  ['<', '<https://x.y>'],
  ['&', '&amp;'],
  ['*', '*em* w'],
  ['*', '**b** w'],
  ['_', '_em_ w'],
  ['`', '`c` w'],
  ['~', '~~s~~ w'],
]
const WRAPS: [string, string][] = [
  ['', ''],
  ['- ', ''],
  ['> ', ''],
  ['1. ', ''],
  ['| h | ', ' |\n|---|---|\n| x | y |'],
  ['| h | k |\n|---|---|\n| ', ' | y |'],
]

/**
 * Lines of a repeated punctuation character followed by a construct starting with it.
 * `literal` lists, for the characters that always stay text (`[`, `!`, `<`, `&`), where
 * the repeats start and how many there are: one run starts there, none inside.
 */
function repeated(rnd: (n: number) => number): {
  src: string
  literal: { at: number; count: number }[]
} {
  let src = ''
  const literal: { at: number; count: number }[] = []
  for (let lines = 1 + rnd(3); lines > 0; lines--) {
    const [c, construct] = CONSTRUCTS[rnd(CONSTRUCTS.length)] as [string, string]
    const [pre, post] = WRAPS[rnd(WRAPS.length)] as [string, string]
    const lead = rnd(2) ? 'x ' : ''
    const count = 1 + rnd(4)
    if ('[!<&'.includes(c)) literal.push({ at: src.length + pre.length + lead.length, count })
    src += `${pre}${lead}${c.repeat(count)}${construct}${post}\n`
  }
  return { src, literal }
}

describe('where a run starts', () => {
  it('is exact when the run repeats the character after it, or is unmapped', () => {
    const cases: [string, string, number][] = [
      ['[[a](u)', '[', 0],
      ['!![a](u)', '!', 0],
      ['!!!![Img](i)', '!!!', 0],
      ['<<https://x.y> w', '<', 0],
      ['&&amp; z', '&', 0],
      ['x\n[[[b](u) y', '[[', 2],
    ]
    for (const [src, run, at] of cases) {
      const hit = runsOf(src).find((r) => r.text.startsWith(run) && r.at !== undefined)
      if (hit) expect([src, hit.at]).toEqual([src, at])
    }
  })

  it('maps a run that starts with a bracket', () => {
    for (const [src, want, at] of [
      ['- [ ] Todo\n', '[ ] Todo', 2],
      ['[a] b\n', '[a] b', 0],
      ['x [a] b\n', 'x [a] b', 0],
      ['[[a](u)\n', '[', 0],
    ] as const) {
      const r = runsOf(src).find((x) => x.text.includes(want.slice(0, 1)) && x.at === at)
      expect(r, src).toBeDefined()
      expect(r?.block.src.slice(r.at, r.at + r.text.length), src).toBe(r?.text)
    }
  })

  it(
    'is the first unconsumed character: changing it changes the run at index 0',
    () => {
      let seed = 5
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed % n
      }
      const alphabet = [
        '[',
        ']',
        '(',
        ')',
        '!',
        '<',
        '>',
        '&',
        '*',
        '_',
        '`',
        '\\',
        'a',
        'b',
        ' ',
        '\n',
        '#',
        '|',
        ':',
        '~',
      ]
      const trials = FUZZ ? 4000 : 150
      let conclusive = 0
      for (let t = 0; t < trials; t++) {
        // Half the documents: a run of one punctuation character right before a
        // construct that starts with it, in a paragraph, item, quote or table cell.
        let src = ''
        let literal: { at: number; count: number }[] = []
        if (t % 2 === 0) ({ src, literal } = repeated(rnd))
        else for (let n = 1 + rnd(14); n > 0; n--) src += alphabet[rnd(alphabet.length)]
        const base = visible(src)
        for (const r of runsOf(src)) {
          expect(r.block.src.slice(r.at, r.at + r.text.length), JSON.stringify(src)).toBe(r.text)
          const abs = r.block.offset + r.at
          // No run starts inside a repeat of a literal character, after its first.
          for (const l of literal)
            expect(abs > l.at && abs <= l.at + l.count, JSON.stringify(src)).toBe(false)
          const c = src[abs] === 'Z' ? 'Y' : 'Z'
          const mutated = visible(src.slice(0, abs) + c + src.slice(abs + 1))
          if (mutated.length !== base.length) continue
          const diffs = [...base].flatMap((ch, i) => (ch === mutated[i] ? [] : [i]))
          if (diffs.length !== 1) continue
          conclusive++
          expect(diffs[0], JSON.stringify(src)).toBe(blockStart(src, r.block) + r.index)
        }
      }
      expect(conclusive).toBeGreaterThan(20)
    },
    FUZZ ? 600_000 : 20_000,
  )

  it('does not give a twin or a block to an element that left the container', () => {
    const { renderer, container } = mount('a *b*\n\nc\n')
    const gone = container.children[1] as Element
    expect(renderer.twin(gone)).not.toBeNull()
    gone.remove()
    expect(renderer.twin(gone)).toBeNull()
    expect(renderer.blockAt(gone)).toBeNull()
  })
})

/** Where a block's text starts in the visible text of the document. */
function blockStart(src: string, block: Block): number {
  const { blocks, references } = parseBlocks(src)
  let n = 0
  for (const b of blocks) {
    if (b === block || b.offset === block.offset) return n
    n += text(renderBlock(b, envOf(references))).length
  }
  return n
}
