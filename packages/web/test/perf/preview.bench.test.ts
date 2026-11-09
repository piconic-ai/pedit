// @vitest-environment jsdom

// Preview benchmark. Skipped unless PERF=1, so the normal suite stays fast:
//
//   PERF=1 npx vitest run test/perf/preview.bench.test.ts    (in packages/web)
//
// CI runs it on a schedule (.github/workflows/bench.yml). It does not compare
// milliseconds with fixed numbers: the main guard is work counts (blocks
// rendered, lines parsed, keys computed, rects read), which do not depend on the
// machine. Times are only compared with other times of the same run (a whole-
// document render, the same edit in a smaller document), plus loose ceilings.
// The numbers go to stdout as a Markdown table, and to GITHUB_STEP_SUMMARY when set.

import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BlockRenderer } from '../../src/blockrender.ts'
import { followTarget } from '../../src/pane.ts'

const PERF = Boolean(process.env.PERF)

// What a keystroke makes the pipeline work on, counted where the modules meet.
const work = vi.hoisted(() => ({ lines: 0, keys: 0, rendered: 0, rects: 0 }))
vi.mock('../../src/preview.ts', async (original) => {
  const real = await original<typeof import('../../src/preview.ts')>()
  return {
    ...real,
    parseSegment: (...args: Parameters<typeof real.parseSegment>) => {
      work.lines += countLines(args[0])
      return real.parseSegment(...args)
    },
    keyOf: (...args: Parameters<typeof real.keyOf>) => {
      work.keys++
      return real.keyOf(...args)
    },
    renderBlock: (...args: Parameters<typeof real.renderBlock>) => {
      work.rendered++
      return real.renderBlock(...args)
    },
  }
})
const { render } = await import('../../src/preview.ts')

function countLines(text: string): number {
  let n = 1
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return n
}

const SIZES = [2_000, 10_000, 35_000] as const
const KEYSTROKES = 21

/** A mixed document of about `lines` lines: every construct a preview draws. */
function generate(lines: number): string {
  const out: string[] = ['# Benchmark document', '']
  for (let n = 0; out.length < lines; n++) {
    out.push(...section(n), '')
  }
  return out.join('\n')
}

function section(n: number): string[] {
  const kinds: string[][] = [
    [
      `Paragraph ${n} with *emphasis*, **strong**, \`code\`, [a link](https://example.com/${n}) and a tail.`,
    ],
    [`## Heading ${n}`],
    [`- item ${n}`, `- item **${n}b**`, '  - nested item'],
    [`${n}. first`, `${n + 1}. second`],
    ['> quoted text', `> second line ${n}`],
    ['| a | b |', '|---|---|', `| ${n} | x |`, '| y | z |'],
    ['```js', `const x${n} = ${n}`, 'console.log(x)', '```'],
    [`![image ${n}](pic-${n % 7}.png)`],
    [`Paragraph ${n} refers to [ref${n % 5}] and ~~strike~~ text.`],
    ['---'],
  ]
  return kinds[n % kinds.length] as string[]
}

interface Row {
  lines: number
  scenario: string
  ms: number
  work: string
}
interface Count {
  lines: number
  keys: number
  rendered: number
  rects: number
}

const results = new Map<string, { ms: number; count: Count }>()
const rows: Row[] = []

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number
const take = (): Count => {
  const c = { ...work }
  work.lines = work.keys = work.rendered = work.rects = 0
  return c
}
const maxOf = (cs: Count[]): Count => ({
  lines: Math.max(...cs.map((c) => c.lines)),
  keys: Math.max(...cs.map((c) => c.keys)),
  rendered: Math.max(...cs.map((c) => c.rendered)),
  rects: Math.max(...cs.map((c) => c.rects)),
})

function record(size: number, scenario: string, ms: number, count: Count): void {
  results.set(`${size} ${scenario}`, { ms, count })
  const w = `${count.rendered} blocks rendered, ${count.lines} lines parsed, ${count.keys} keys, ${count.rects} rects`
  rows.push({ lines: size, scenario, ms, work: w })
}

const timed = (fn: () => void): number => {
  const t = performance.now()
  fn()
  return performance.now() - t
}

/** The offset where the paragraph nearest `at` (a fraction of the lines) ends. */
function paragraphEnd(text: string, at: number): number {
  const lines = text.split('\n')
  let i = Math.min(lines.length - 2, Math.floor(lines.length * at))
  const step = at > 0.9 ? -1 : 1
  while (!(lines[i] as string).startsWith('Paragraph')) i += step
  let offset = 0
  for (let k = 0; k <= i; k++) offset += (lines[k] as string).length + 1
  return offset - 1
}

/** Applies `edit` to the text KEYSTROKES times, updating after each: the median time and the worst work. */
function keystrokes(
  renderer: BlockRenderer,
  start: string,
  edit: (text: string) => string,
): { ms: number; count: Count } {
  let text = start
  const times: number[] = []
  const counts: Count[] = []
  for (let k = 0; k < KEYSTROKES; k++) {
    text = edit(text)
    take()
    times.push(timed(() => renderer.update(text)))
    counts.push(take())
  }
  return { ms: median(times), count: maxOf(counts) }
}

/** Fake layout for followTarget: a block's top is 20px per line of the document. */
function mockLayout(pane: HTMLElement): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: Element,
  ) {
    work.rects++
    const line = (el: Element) => Number(el.getAttribute('data-line') ?? 0)
    let root: Element = this
    while (root.parentElement && root.parentElement !== pane) root = root.parentElement
    const abs = this === pane ? 0 : line(root) + (this === root ? 0 : line(this))
    return {
      top: abs * 20,
      bottom: abs * 20,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: abs * 20,
    } as DOMRect
  })
  return () => spy.mockRestore()
}

function measureFollow(size: number, pane: HTMLElement, docLines: number): void {
  Object.defineProperty(pane, 'scrollHeight', { value: docLines * 20, configurable: true })
  const restore = mockLayout(pane)
  const times: number[] = []
  const counts: Count[] = []
  for (const at of [0.5, 0.01, 0.99, 0.25, 0.75, 0.5, 0.6]) {
    take()
    times.push(timed(() => followTarget(pane, Math.floor(docLines * at), docLines)))
    counts.push(take())
  }
  restore()
  record(size, 'follow (mocked rects)', median(times), maxOf(counts))
}

function measureSize(size: number): void {
  const text = generate(size)
  const docLines = countLines(text)
  const container = document.createElement('article')
  document.body.append(container)
  const renderer = new BlockRenderer(container)

  take()
  const first = timed(() => renderer.update(text))
  const firstWork = take()
  record(size, 'first render', first, firstWork)
  const blocks = firstWork.rendered

  take()
  const whole = timed(() => render(text))
  take()
  record(size, 'whole-document render() (reference)', whole, {
    lines: 0,
    keys: 0,
    rendered: 0,
    rects: 0,
  })
  results.set(`${size} blocks`, { ms: blocks, count: firstWork })

  for (const [name, at] of [
    ['mid', 0.5],
    ['top', 0],
    ['end', 1],
  ] as const) {
    const r = keystrokes(renderer, text, (t) => {
      const o = paragraphEnd(t, at)
      return `${t.slice(0, o)}x${t.slice(o)}`
    })
    record(size, `type a character, ${name} (median of ${KEYSTROKES})`, r.ms, r.count)
    renderer.update(text)
  }
  const enter = keystrokes(renderer, text, (t) => {
    const o = paragraphEnd(t, 0.5) - 3
    return `${t.slice(0, o)}\n${t.slice(o)}`
  })
  record(size, `Enter, mid (median of ${KEYSTROKES})`, enter.ms, enter.count)
  renderer.update(text)

  measureFollow(size, container, docLines)
  container.remove()
}

const f1 = (n: number) => n.toFixed(n < 10 ? 2 : 1)

function table(): string {
  const head = '| Lines | Scenario | ms | Work (worst keystroke) |\n| ---: | --- | ---: | --- |\n'
  const body = rows
    .map((r) => `| ${r.lines} | ${r.scenario} | ${f1(r.ms)} | ${r.work} |`)
    .join('\n')
  return `### Preview benchmark\n\n${head}${body}\n`
}

const get = (size: number, scenario: string) => {
  const r = results.get(`${size} ${scenario}`)
  if (!r) throw new Error(`no result for ${size} ${scenario}`)
  return r
}
const TYPE = `type a character, mid (median of ${KEYSTROKES})`

describe.skipIf(!PERF)('preview benchmark', () => {
  beforeAll(() => {
    for (const size of SIZES) measureSize(size)
  }, 600_000)

  afterAll(() => {
    const md = table()
    process.stdout.write(`\n${md}\n`)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`)
  })

  it('has the documents it claims to measure', () => {
    for (const size of SIZES)
      expect(get(size, 'first render').count.rendered).toBeGreaterThan(size / 20)
  })

  it.each(SIZES)('an edit works on a few blocks, not the document (%i lines)', (size) => {
    const scenarios = [
      TYPE,
      `type a character, top (median of ${KEYSTROKES})`,
      `type a character, end (median of ${KEYSTROKES})`,
      `Enter, mid (median of ${KEYSTROKES})`,
    ]
    for (const s of scenarios) {
      const { count } = get(size, s)
      expect(count.rendered, `${s}: blocks rendered`).toBeLessThanOrEqual(4)
      expect(count.lines, `${s}: lines parsed`).toBeLessThanOrEqual(200)
      expect(count.keys, `${s}: keys computed`).toBeLessThanOrEqual(60)
    }
  })

  it('following the editor reads the layout of a few blocks', () => {
    for (const size of SIZES) {
      expect(get(size, 'follow (mocked rects)').count.rects).toBeLessThanOrEqual(60)
    }
  })

  it('an edit at 35,000 lines is a small fraction of rendering the document', () => {
    const whole = get(35_000, 'whole-document render() (reference)').ms
    for (const s of [TYPE, `Enter, mid (median of ${KEYSTROKES})`]) {
      const ms = get(35_000, s).ms
      expect(ms, `${s}: ${f1(ms)} ms vs ${f1(whole)} ms`).toBeLessThanOrEqual(whole * 0.1)
    }
  })

  it('typing does not get much slower as the document grows', () => {
    const small = Math.max(get(2_000, TYPE).ms, 1)
    const large = get(35_000, TYPE).ms
    expect(large, `${f1(large)} ms at 35,000 lines, ${f1(small)} ms at 2,000`).toBeLessThanOrEqual(
      small * 8,
    )
  })

  it('stays under loose ceilings (a sanity check, not a budget)', () => {
    expect(get(35_000, TYPE).ms).toBeLessThan(500)
    expect(get(35_000, `Enter, mid (median of ${KEYSTROKES})`).ms).toBeLessThan(1_000)
    expect(get(35_000, 'first render').ms).toBeLessThan(120_000)
  })
})
