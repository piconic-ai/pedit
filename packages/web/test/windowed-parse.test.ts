// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { BlockParser } from '../src/blockparse.ts'
import { BlockRenderer } from '../src/blockrender.ts'
import { type Block, keyOf, parseBlocks } from '../src/preview.ts'
import corpus from './fixtures/preview-corpus.json'

// The block parser and keyOf, counted: what a keystroke makes them work on.
vi.mock('../src/preview.ts', async (original) => {
  const real = await original<typeof import('../src/preview.ts')>()
  return { ...real, parseSegment: vi.fn(real.parseSegment), keyOf: vi.fn(real.keyOf) }
})
const preview = await import('../src/preview.ts')
const parsedTexts = () => vi.mocked(preview.parseSegment).mock.calls.map((c) => c[0])
const keyed = () => vi.mocked(preview.keyOf).mock.calls.length

const FUZZ = Boolean(process.env.FUZZ)
const LIMIT = FUZZ ? 120_000 : 15_000

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** What a block is, for comparing: positions, source, and every token field. */
function view(b: Block) {
  const { line, lineEnd, offset, src, unmapped } = b
  const tokens = b.tokens.map((t) => [
    t.type,
    t.tag,
    t.nesting,
    t.level,
    t.markup,
    t.info,
    t.content,
    t.hidden,
    t.block,
    t.map,
    t.attrs,
    t.meta,
  ])
  return { line, lineEnd, offset, src, unmapped, tokens }
}

/**
 * Feeds `source` to `parser` and checks it is what a whole parse gives, and that the
 * blocks the update says it kept are the very objects of the last one.
 */
function expectWhole(parser: BlockParser, before: Block[], source: string, message: string) {
  const got = parser.update(source)
  const want = parseBlocks(source)
  expect(got.blocks.map(view), message).toEqual(want.blocks.map(view))
  expect(JSON.stringify(got.references), message).toBe(JSON.stringify(want.references))
  expect(got.refs, message).toBe(want.refs)
  got.blocks.forEach((b, i) => {
    expect(keyOf(b, got.refs, 0, false), message).toBe(
      keyOf(want.blocks[i] as Block, want.refs, 0, false),
    )
  })
  const { from, oldTo, to } = got
  for (let i = 0; i < from; i++) expect(got.blocks[i] === before[i], message).toBe(true)
  const shift = got.blocks.length - to
  for (let i = 0; i < shift; i++)
    expect(got.blocks[to + i] === before[oldTo + i], message).toBe(true)
  return got
}

const pieces = (corpus as [string, string][]).map(([, src]) => src)

// Lines a random document is made of: every construct a cut has to respect.
function section(next: () => number, n: number): string[] {
  const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)] as T
  const kinds: (() => string[])[] = [
    () => [`Paragraph ${n} with *em* and [a](u) and [r${n % 5}] and a tail`],
    () => [`Lazy ${n} start`, 'lazy continuation line', 'and another'],
    () => [`# Heading ${n}`],
    () => [`Setext ${n}`, pick(['===', '---', '=='])],
    () => [`- tight ${n}`, `- two ${n}`, '  - nested'],
    () => [`- loose ${n}`, '', `- loose two ${n}`, '', '  continued'],
    () => [`${n}. first`, `${n + 1}. second`],
    () => ['> quote', `lazy quote ${n}`, '> more'],
    () => ['```js', `const x${n} = 1`, '', '```'],
    () => ['~~~', 'unfenced', '~~~~'],
    () => ['| a | b |', '|---|---|', `| ${n} | x |`],
    () => [`[r${n % 5}]: /url${n} "title ${n}"`],
    () => ['    indented code', '', '    more code'],
    () => ['***'],
    () => ['* * *'],
    () => ['1) paren', '2) list'],
    () => ['Text with trailing spaces  ', 'next\\', 'last'],
  ]
  return pick(kinds)()
}

function bigDoc(next: () => number, sections: number, front: boolean): string[] {
  const lines: string[] = front ? ['---', 'title: x', 'tags: [a, b]', '---', ''] : []
  for (let i = 0; i < sections; i++) lines.push(...section(next, i), '')
  return lines
}

const NOISE = ['*', '[', ']', '`', '#', '>', '-', ' ', '|', '=', ':', '+', '1. ', '\t', ' ', '_']
const LINES = [
  '```',
  '~~~',
  '---',
  '===',
  '[r1]: /u',
  '    code',
  '- item',
  '1. x',
  '> q',
  '***',
  '',
]

/** One random edit of a document's lines. */
function mutate(lines: string[], next: () => number, source: string[]): void {
  const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)] as T
  const at = Math.floor(next() * (lines.length + 1))
  const op = Math.floor(next() * 8)
  if (op === 0) lines.splice(at, 0, ...pick(source).split('\n'))
  else if (op === 1) lines.splice(at, 1 + Math.floor(next() * 3))
  else if (op === 2) {
    const moved = lines.splice(at, 1 + Math.floor(next() * 3))
    lines.splice(Math.floor(next() * (lines.length + 1)), 0, ...moved)
  } else if (op === 3 && lines[at] !== undefined) {
    const line = lines[at] as string
    const c = Math.floor(next() * (line.length + 1))
    lines[at] =
      next() < 0.6
        ? line.slice(0, c) + pick(NOISE) + line.slice(c)
        : line.slice(0, c) + line.slice(c + 1)
  } else if (op === 4) lines.splice(at, 0, '')
  else if (op === 5) lines.splice(at, 1, pick(LINES))
  else if (op === 6) {
    const blank = lines.findIndex((l, i) => i >= at && l === '')
    if (blank >= 0) lines.splice(blank, 1)
  } else if (lines[at] !== undefined) lines[at] = `${lines[at]}${pick(['  ', 'x', '\\'])}`
}

function run(
  seed: number,
  steps: number,
  build: (next: () => number) => string[],
  source: string[],
  check: (text: string, message: string) => void,
) {
  const next = rng(seed)
  const eol = ['\n', '\n', '\r\n', '\r'][seed % 4] as string
  const lines = build(next)
  check(lines.join(eol), `seed ${seed} start`)
  for (let step = 0; step < steps; step++) {
    mutate(lines, next, source)
    check(lines.join(eol), `seed ${seed} step ${step}`)
  }
}

function differential(seed: number, steps: number, build: (next: () => number) => string[]) {
  const parser = new BlockParser(0)
  let before: Block[] = []
  run(seed, steps, build, pieces, (text, message) => {
    before = expectWhole(parser, before, text, message).blocks.slice()
  })
}

describe('BlockParser against a whole parse', () => {
  it(
    'equals it after every random edit of corpus documents',
    () => {
      const [seeds, steps] = FUZZ ? [40, 120] : [6, 30]
      for (let seed = 1; seed <= seeds; seed++) {
        differential(seed, steps, (next) =>
          Array.from({ length: 30 }, () => pieces[Math.floor(next() * pieces.length)] as string)
            .join('\n\n')
            .split('\n'),
        )
      }
    },
    LIMIT,
  )

  it(
    'equals it after every random edit of long generated documents',
    () => {
      const [seeds, steps, sections] = FUZZ ? [8, 150, 400] : [3, 40, 250]
      for (let seed = 1; seed <= seeds; seed++) {
        differential(seed, steps, (next) => bigDoc(next, sections, seed % 2 === 0))
      }
    },
    LIMIT,
  )

  it('windows most edits of a long document', () => {
    const next = rng(7)
    const lines = bigDoc(next, 300, false)
    const parser = new BlockParser(0)
    parser.update(lines.join('\n'))
    let windowed = 0
    for (let i = 0; i < 20; i++) {
      const at = 200 + Math.floor(next() * 200)
      lines[at] = `${lines[at]}x`
      const got = parser.update(lines.join('\n'))
      if (got.to - got.from < got.blocks.length / 4) windowed++
    }
    expect(windowed).toBeGreaterThan(15)
  })
})

describe('BlockParser hazards', () => {
  const filler = (n: number, tag = 'P') =>
    Array.from({ length: n }, (_, i) => `${tag} ${i} text [x]`).join('\n\n')
  const check = (...texts: string[]) => {
    const parser = new BlockParser(0)
    let before: Block[] = []
    texts.forEach((text, i) => {
      before = expectWhole(parser, before, text, `step ${i}`).blocks.slice()
    })
  }

  it('sees a fence opened or closed far above', () => {
    const base = `${filler(40)}\n\n\`\`\`js\ncode\n\`\`\`\n\n${filler(40, 'Q')}\n`
    const open = base.replace('P 3 text', '```\nP 3 text')
    check(base, open, base, open.replace('Q 3 text', '```\nQ 3 text'), open, base)
    check(base, base.replace('code\n```\n', 'code\n'), base)
    check(base, base.replace('```js', '~~~'), base.replace('```js', '````'), base)
  })

  it('sees a line become a setext underline', () => {
    const base = `${filler(40)}\n\nTitle\ntext\n\n${filler(40, 'Q')}\n`
    check(base, base.replace('text\n\n', 'text\n===\n'), base.replace('text\n\n', 'text\n---\n'))
    check(base, base.replace('Title\ntext\n\n', 'Title\ntext\n\n=\n\n'), base)
  })

  it('sees lists join and split across a blank line', () => {
    const base = `${filler(30)}\n\n- one\n\nBetween\n\n- two\n\n${filler(30, 'Q')}\n`
    check(base, base.replace('Between', '- mid'), base, base.replace('Between\n\n', ''), base)
    const ordered = base.replaceAll('- one', '1. one').replace('- two', '2. two')
    check(
      ordered,
      ordered.replace('Between', '2. mid'),
      ordered.replace('Between\n\n', '  mid\n\n'),
    )
  })

  it('sees a reference definition added or removed far away', () => {
    const base = `[x]: /top "first"\n\n${filler(60)}\n\n[x]: /late "second"\n\n[y]: /y\n\n${filler(20, 'Q')}\n`
    check(
      base,
      base.replace('[x]: /top "first"\n\n', ''),
      base,
      base.replace('[x]: /late "second"\n\n', ''),
      base.replace('[x]: /top "first"\n\n', '').replace('[x]: /late "second"\n\n', ''),
      base.replace('P 30 text [x]', '[z]: /new\n\nP 30'),
    )
  })

  it('sees frontmatter appear and disappear at the top', () => {
    const body = filler(60)
    const front = `---\ntitle: a\n---\n\n${body}\n`
    check(front, front.slice(4), front, front.replace('---\n\n', 'x\n\n'), front)
    // An opening line with no closing one yet, which a line far below then closes.
    const open = `---\ntitle: a\n\n${body}\n`
    check(open, open.replace('P 40', '---\nP 40'), open, `${open}---\n`, open)
    check(open, open.replace('P 59 text [x]', 'P 59 text [x]\n---\n\nmore'), open)
  })

  it('sees edits in CRLF and lone CR text', () => {
    for (const eol of ['\r\n', '\r']) {
      const base = `${filler(40)}\n\n\`\`\`\ncode\n\`\`\`\n\n${filler(20, 'Q')}\n`.replaceAll(
        '\n',
        eol,
      )
      check(base, base.replace('P 20', 'P\n20'), base.replace(`code${eol}`, ''), base)
    }
  })
})

// Markup with each element's attributes in name order: the order they were set in is
// no part of what is shown.
function canon(node: Node): string {
  if (node.nodeType !== 1) return node.textContent ?? ''
  const el = node as Element
  const attrs = [...el.attributes].map((a) => `${a.name}=${JSON.stringify(a.value)}`).sort()
  return `<${el.localName} ${attrs.join(' ')}>${[...el.childNodes].map(canon).join('')}</>`
}

describe('BlockRenderer with a windowed parse', () => {
  it(
    'shows what a fresh renderer shows after every random edit',
    () => {
      const [seeds, steps] = FUZZ ? [10, 60] : [3, 18]
      for (let seed = 1; seed <= seeds; seed++) {
        const container = document.createElement('article')
        const incremental = new BlockRenderer(container, { windowAbove: 0 })
        run(
          seed,
          steps,
          (next) => bigDoc(next, 14, seed % 2 === 0),
          pieces,
          (text, message) => {
            incremental.update(text, undefined, 0, [])
            const fresh = document.createElement('article')
            new BlockRenderer(fresh, { windowAbove: Number.POSITIVE_INFINITY }).update(
              text,
              undefined,
              0,
              [],
            )
            expect(canon(container), message).toBe(canon(fresh))
          },
        )
      }
    },
    LIMIT,
  )
})

describe('a keystroke in a very long document', () => {
  const lines: string[] = []
  for (let i = 0; i < 13_000; i++)
    lines.push(`Paragraph ${i} with [a link](u) and *em*`, '', `- item ${i}`, '')
  const source = lines.join('\n')

  it(
    'parses a window of bounded size and keys only the new blocks',
    () => {
      const container = document.createElement('article')
      const renderer = new BlockRenderer(container, { windowAbove: 0 })
      renderer.update(source, undefined, 0, [])
      expect(source.split('\n').length).toBeGreaterThan(50_000)
      const edited = lines.slice()
      for (const at of [0, 20_000, 49_000]) {
        vi.mocked(preview.parseSegment).mockClear()
        vi.mocked(preview.keyOf).mockClear()
        edited[at] = `${edited[at]}x`
        renderer.update(edited.join('\n'), undefined, 0, [])
        const texts = parsedTexts()
        expect(texts).toHaveLength(1)
        expect((texts[0] as string).split('\n').length).toBeLessThan(40)
        expect(keyed()).toBeLessThan(6)
        expect(container.children.length).toBeGreaterThan(24_000)
      }
    },
    LIMIT,
  )

  it(
    'moves the lines below when a line is added, and parses the same window',
    () => {
      const container = document.createElement('article')
      const renderer = new BlockRenderer(container, { windowAbove: 0 })
      renderer.update(source, undefined, 0, [])
      vi.mocked(preview.parseSegment).mockClear()
      const edited = lines.slice()
      edited.splice(30_000, 0, 'Inserted', '')
      renderer.update(edited.join('\n'), undefined, 0, [])
      expect((parsedTexts()[0] as string).split('\n').length).toBeLessThan(40)
      const last = container.lastElementChild as Element
      expect(last.getAttribute('data-line')).toBe(String(edited.length - 2))
    },
    LIMIT,
  )
})
