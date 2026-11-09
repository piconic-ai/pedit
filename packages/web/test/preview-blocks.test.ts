// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import type { ImageResolver } from '../src/core/attachments.ts'
import {
  type Block,
  type BlockEnv,
  keyOf,
  parseBlocks,
  render,
  renderBlock,
} from '../src/preview.ts'
import corpus from './fixtures/preview-corpus.json'

const MEDIA: readonly string[] = []

function mixed(lines: number): string {
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
  return out.slice(0, lines).join('\n') + '\n'
}

const plain = (): BlockEnv => ({ media: MEDIA, breaks: false, references: {} })

/** What main renders: the document in one go. */
function whole(source: string, options: { images?: ImageResolver; breaks?: boolean }): string[] {
  return [...render(source, options.images, MEDIA, { breaks: options.breaks }).children].map(
    (el) => el.outerHTML,
  )
}

/** Block-relative data-line to absolute, on the roots and nested. */
function absolute(el: Element, line: number): string {
  const copy = el.cloneNode(true) as Element
  for (const e of [copy, ...copy.querySelectorAll('[data-line]')]) {
    if (!e.hasAttribute('data-line')) continue
    e.setAttribute('data-line', String(Number(e.getAttribute('data-line')) + line))
  }
  return copy.outerHTML
}

function byBlock(
  source: string,
  options: { images?: ImageResolver; breaks?: boolean } = {},
): string[] {
  const { blocks, references } = parseBlocks(source)
  const env: BlockEnv = {
    images: options.images,
    media: MEDIA,
    breaks: options.breaks ?? false,
    references,
  }
  return blocks.flatMap((b) => renderBlock(b, env).map((el) => absolute(el, b.line)))
}

function expectSame(source: string, options: { images?: ImageResolver; breaks?: boolean } = {}) {
  expect(byBlock(source, options)).toEqual(whole(source, options))
}

const keys = (source: string, refs?: string, version = 0, breaks = false) => {
  const parsed = parseBlocks(source)
  return parsed.blocks.map((b) => keyOf(b, refs ?? parsed.refs, version, breaks))
}

describe('renderBlock over parseBlocks equals render', () => {
  it('the mixed document', () => {
    expectSame(mixed(2000))
  })

  it.each(corpus as [string, string][])('corpus: %s', (_name, src) => {
    expectSame(src)
  })

  it('frontmatter, and the same --- later', () => {
    expectSame('---\ntitle: a\ntags: [x, y]\n---\n\n# Hi\n')
    expectSame('# Hi\n\n---\ntitle: a\n---\n\ntext\n')
    expectSame('---\nbroken: [\n---\n\ntext\n')
  })

  it('embeds and snippets', () => {
    expectSame(
      [
        'intro',
        '',
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        '',
        '- https://vimeo.com/76979871',
        '- text',
        '',
        'https://github.com/piconic-ai/pedit/blob/main/README.md#L1-L5',
        '',
        'https://example.com/clip.mp4',
        '',
      ].join('\n'),
    )
  })

  it('images with a resolver', () => {
    const url = 'blob:http://localhost/1234'
    const images: ImageResolver = {
      lookup: (src) =>
        src === 'assets/a.png' ? { url } : src === 'assets/b.png' ? 'loading' : null,
      owns: (u) => u === url,
    }
    const src =
      '![a](assets/a.png) ![b](assets/b.png) ![c](assets/c.png)\n\n![d](https://x.example/d.png)\n'
    expectSame(src, { images })
    expectSame(src)
  })

  it('breaks: true, as canvas cards render', () => {
    expectSame('one\ntwo\nthree\n\n- a\n  b\n- c\n', { breaks: true })
  })

  it('reference definitions used before and after', () => {
    expectSame('see [foo] and [bar][b]\n\n[foo]: /u "t"\n\n> [b] quoted\n\n[b]: /b\n')
  })

  it('files with mixed line endings render as main does', () => {
    expectSame('one\r\ntwo\r\n\r\n- a\r\n- b\n\n```\r\ncode\r\n```\n\nlast\rline\r\n')
    expectSame('a\0b\n\n*c*\n')
  })
})

describe('parseBlocks', () => {
  it('records lines, offsets and the original source of each block', () => {
    const src = 'one\r\ntwo\r\n\r\n# h\n\n[r]: /u\n\n- a\n- b\n'
    const { blocks } = parseBlocks(src)
    expect(blocks.map((b) => [b.line, b.lineEnd, b.offset])).toEqual([
      [0, 2, 0],
      [3, 4, 12],
      [7, 9, 26],
    ])
    expect(blocks.map((b) => b.src)).toEqual(['one\r\ntwo\r\n', '# h\n', '- a\n- b\n'])
    expect(blocks.map((b) => b.unmapped)).toEqual([true, false, false])
    expect(blocks[0]?.tokens[0]?.map).toEqual([0, 2])
    expect(blocks[2]?.tokens[0]?.map).toEqual([0, 2])
    expect(src.slice(blocks[2]?.offset)).toBe(blocks[2]?.src)
  })

  it('flags NUL characters', () => {
    expect(parseBlocks('a\0b\n').blocks[0]?.unmapped).toBe(true)
  })

  it('leaves inline tokens without children, and finds the references', () => {
    const { blocks, references, refs } = parseBlocks('a *b*\n\n[x]: /y\n')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.tokens.find((t) => t.type === 'inline')?.children).toEqual([])
    expect(Object.keys(references)).toEqual(['X'])
    expect(refs).toMatch(/^\w+\.\w+$/)
    expect(parseBlocks('a *b*\n\n[x]: /z\n').refs).not.toBe(refs)
  })

  it('gives nested data-line relative to the block', () => {
    const { blocks } = parseBlocks('x\n\n- a\n- b\n\n  c\n')
    const el = renderBlock(blocks[1] as Block, plain())[0] as Element
    expect(el.getAttribute('data-line')).toBe('0')
    expect([...el.querySelectorAll('[data-line]')].map((e) => e.getAttribute('data-line'))).toEqual(
      ['0', '0', '1', '1', '3'],
    )
    expect(blocks[1]?.line).toBe(2)
  })

  it('renders a block twice with the same result', () => {
    const { blocks } = parseBlocks('a *b* [c](d)\n')
    const b = blocks[0] as Block
    expect(renderBlock(b, plain())[0]?.outerHTML).toBe(renderBlock(b, plain())[0]?.outerHTML)
  })

  it('sanitises each block with the same hooks', () => {
    const { blocks } = parseBlocks('![x](blob:http://localhost/y)\n\n[a](https://example.com/)\n')
    const out = blocks.flatMap((b) => renderBlock(b, plain()))
    expect(out.map((e) => e.querySelector('img')).filter(Boolean)).toEqual([])
    expect(out[1]?.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('keyOf', () => {
  it('is equal for identical blocks at different lines', () => {
    const k = keys('same *text*\n\nother\n\n\n\nsame *text*\n')
    expect(k[0]).toBe(k[2])
    expect(k[0]).not.toBe(k[1])
  })

  it('is the same for the same block elsewhere, whatever lies around it', () => {
    expect(keys('a *x*\n\nb\n')[0]).toBe(keys('z\n\n\n\na *x*\n')[1])
    expect(keys('x\n\n- a\n  - b\n')[1]).toBe(keys('y\n\ny\n\n- a\n  - b\n')[2])
  })

  it.each([
    ['- a\n\n- b\n', '- a\n\n\n- b\n'],
    ['> a\n>\n> b\n', '> a\n>\n>\n> b\n'],
    ['- a\n\n  b\n', '- a\n\n\n  b\n'],
    [
      '- https://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n- b\n',
      '- https://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n\n- b\n',
    ],
    ['- a\n', '-   a\n'],
    ['# h\n', '#   h  #\n'],
    ['> a\n', '>    a\n'],
    ['a\n', '   a\n'],
    ['***\n', '* * *\n'],
  ])('tells %j from %j (the output or its source map differs)', (a, b) => {
    expect(keys(a)).toHaveLength(1)
    expect(keys(b)).toHaveLength(1)
    expect(keys(a)[0]).not.toBe(keys(b)[0])
  })

  it('re-keys only blocks with [ when a reference definition changes', () => {
    const a = keys('plain\n\nsee [foo]\n\n```\n[x]\n```\n\n[foo]: /one\n')
    const b = keys('plain\n\nsee [foo]\n\n```\n[x]\n```\n\n[foo]: /two\n')
    expect(a[0]).toBe(b[0])
    expect(a[1]).not.toBe(b[1])
    // A fence with a [ may use none, but is re-keyed too (conservative).
    expect(a[2]).not.toBe(b[2])
  })

  it('re-keys only blocks with ![ when the images version changes', () => {
    const src = 'plain\n\n[a](b)\n\n![i](a.png)\n'
    const a = keys(src, undefined, 0)
    const b = keys(src, undefined, 1)
    expect(a[0]).toBe(b[0])
    expect(a[1]).toBe(b[1])
    expect(a[2]).not.toBe(b[2])
  })

  it('tells breaks apart', () => {
    expect(keys('a\nb\n')[0]).not.toBe(keys('a\nb\n', undefined, 0, true)[0])
  })

  it('tells frontmatter at line 0 from the same --- later', () => {
    const first = keys('---\na: 1\n---\n')
    const later = keys('x\n\n---\na: 1\n---\n')
    expect(first).toHaveLength(1)
    expect(later[1]).not.toBe(first[0])
  })

  it('tells a loose list from a tight one', () => {
    expect(keys('- a\n- b\n')[0]).not.toBe(keys('- a\n\n- b\n')[0])
  })

  it('tells a setext heading from a paragraph and a rule', () => {
    const setext = keys('title\n---\n')
    const split = keys('title\n\n---\n')
    expect(setext).toHaveLength(1)
    expect(split).toHaveLength(2)
    expect(setext[0]).not.toBe(split[0])
  })

  it('tells a lazy continuation from a separate paragraph', () => {
    const lazy = keys('> a\nb\n')
    const apart = keys('> a\n\nb\n')
    expect(lazy).toHaveLength(1)
    expect(apart).toHaveLength(2)
    expect(lazy[0]).not.toBe(apart[0])
  })

  it('tells table alignment apart', () => {
    expect(keys('| a |\n|:--|\n| b |\n')[0]).not.toBe(keys('| a |\n|--:|\n| b |\n')[0])
    expect(keys('| a |\n|:--|\n| b |\n')[0]).not.toBe(keys('| a |\n|---|\n| b |\n')[0])
  })

  it('tells ordered list starts apart', () => {
    expect(keys('1. a\n')[0]).not.toBe(keys('3. a\n')[0])
  })

  it('costs about one pass over the block, not more', () => {
    const list = `${Array.from({ length: 40000 }, (_, i) => `- item ${i}`).join('\n')}\n`
    const parsed = parseBlocks(list)
    expect(parsed.blocks).toHaveLength(1)
    const block = parsed.blocks[0] as Block
    // Count the work by doubling the input: a quadratic key would grow four-fold.
    const half = parseBlocks(list.slice(0, list.length / 2)).blocks[0] as Block
    // The best of several runs, so a busy machine does not decide.
    const time = (b: Block) => {
      let best = Number.POSITIVE_INFINITY
      for (let run = 0; run < 9; run++) {
        const t = performance.now()
        keyOf(b, parsed.refs, 0, false)
        best = Math.min(best, performance.now() - t)
      }
      return best
    }
    time(half)
    const [small, big] = [time(half), time(block)]
    expect(big / Math.max(small, 0.05)).toBeLessThan(3.5)
  })

  it('costs well under the block parse on a large document', () => {
    const src = mixed(10000)
    const run = (fn: () => void) => {
      fn()
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < 5; i++) {
        const t = performance.now()
        fn()
        best = Math.min(best, performance.now() - t)
      }
      return best
    }
    const parsed = parseBlocks(src)
    const parse = run(() => parseBlocks(src))
    const key = run(() => {
      for (const b of parsed.blocks) keyOf(b, parsed.refs, 0, false)
    })
    expect(key).toBeLessThan(parse * 0.5)
  })

  it('keeps the key length-prefixed so fields cannot run together', () => {
    expect(keys('a|b\n')[0]).not.toBe(keys('a\n\nb\n')[0])
  })
})
