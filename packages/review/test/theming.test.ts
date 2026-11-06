// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateEditSecret } from '@pedit/protocol'
import { Relay } from '@pedit/protocol/testing'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PeditReview } from '../src/element.ts'
import { resolveLabels } from '../src/labels.ts'

const ID = 'a'.repeat(22)
const hostCss = readFileSync(join(import.meta.dirname, '../src/host.css'), 'utf8')
const cssDir = join(import.meta.dirname, '../../web/src/core/css')
const coreCss = readdirSync(cssDir)
  .map((f) => readFileSync(join(cssDir, f), 'utf8'))
  .join('\n')

/** Declarations `--name: value` inside the blocks whose selector starts with `:host`. */
function hostBlocks(css: string) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:host \{([^}]*)\}\s*\}/.exec(plain)
  const base = /(?:^|\n):host \{([^}]*)\}/.exec(plain)
  const decls = (body = '') =>
    Object.fromEntries(
      [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], (m[2] ?? '').trim()]),
    ) as Record<string, string>
  return { base: decls(base?.[1]), dark: decls(dark?.[1]) }
}

describe('host.css variables', () => {
  const { base, dark } = hostBlocks(hostCss)

  it('defines every variable the core CSS reads, except the ones it sets itself', () => {
    const used = new Set([...coreCss.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
    // --c is set inline on each avatar and comment by the core.
    used.delete('--c')
    expect([...used].filter((v) => !(v && v in base))).toEqual([])
  })

  it.each([
    ['--bg', '--pedit-bg'],
    ['--ink', '--pedit-fg'],
    ['--muted', '--pedit-muted'],
    ['--line', '--pedit-border'],
    ['--accent', '--pedit-accent'],
    ['--sans', '--pedit-font'],
    ['--mono', '--pedit-mono'],
    ['--radius', '--pedit-radius'],
  ])('reads %s from %s with a default', (core, pub) => {
    expect(base[core]).toMatch(new RegExp(`^var\\(${pub}, .+\\)$`))
  })

  it('sets only defaults in the dark block', () => {
    expect(Object.keys(dark).length).toBeGreaterThan(0)
    for (const [name, value] of Object.entries(dark)) {
      if (name === '--warn-bg' || name === '--warn-ink') continue
      expect(value, name).toMatch(/^var\(--pedit-[a-z]+, [^)]+\)$/)
      // The page's own value still wins: the same public property as the light one.
      expect(value.split(',')[0]).toBe((base[name] ?? '').split(',')[0])
    }
  })
})

describe('resolveLabels', () => {
  it('defaults to English, takes ja and a region of it, and ignores unknown languages', () => {
    expect(resolveLabels(null, null).join).toBe('Join')
    expect(resolveLabels('ja', null).join).toBe('参加')
    expect(resolveLabels('ja-JP', null).join).toBe('参加')
    expect(resolveLabels('fr', null).join).toBe('Join')
  })

  it('overrides single strings, ignoring non-strings and unknown keys', () => {
    const l = resolveLabels('en', '{"join":"Enter","comments":3,"nope":"x"}')
    expect(l.join).toBe('Enter')
    expect(l.comments).toBe('Comments')
  })

  it.each(['{', '[]', '"x"', 'null'])('ignores %j with a warning', (json) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveLabels('en', json).join).toBe('Join')
    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0])).toMatch(/labels attribute/)
    warn.mockRestore()
  })
})

describe('<pedit-review> theming', () => {
  let relay: Relay
  beforeAll(async () => {
    await import('../src/index.ts')
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
    Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  })
  beforeEach(() => {
    relay = new Relay()
    ;(customElements.get('pedit-review') as typeof PeditReview).testing = {
      createSocket: relay.create,
    }
    location.hash = `#${ID}.${generateEditSecret()}`
  })
  afterEach(async () => {
    document.body.replaceChildren()
    await vi.waitFor(() => expect([...relay.sockets].filter((s) => s.readyState !== 3)).toEqual([]))
    vi.restoreAllMocks()
    location.hash = ''
  })

  function place(attrs: Record<string, string>, children: HTMLElement[] = []) {
    const el = document.createElement('pedit-review')
    for (const [k, v] of Object.entries({ relay: 'https://relay.test', ...attrs }))
      el.setAttribute(k, v)
    el.append(...children)
    document.body.append(el)
    return el.shadowRoot as ShadowRoot
  }
  const slotted = (tag: string, slot: string, text: string) => {
    const node = document.createElement(tag)
    node.slot = slot
    node.textContent = text
    return node
  }
  const header = async (root: ShadowRoot) =>
    vi.waitFor(() => {
      const h = root.querySelector('.review-header')
      expect(h).not.toBeNull()
      return h as HTMLElement
    })

  it('renders light-DOM logo and title in the header slots', async () => {
    const logo = slotted('img', 'logo', '')
    const title = slotted('span', 'title', 'My doc')
    const stray = slotted('p', '', 'stray')
    const root = place({ name: 'Ana' }, [logo, title, stray])
    const h = await header(root)
    const slot = (n: string) => h.querySelector<HTMLSlotElement>(`slot[name="${n}"]`)
    expect(slot('logo')?.assignedNodes()).toEqual([logo])
    expect(slot('title')?.assignedNodes()).toEqual([title])
    expect(root.querySelector('slot:not([name])')).toBeNull()
  })

  it('shows the file name until a title is given', async () => {
    const root = place({ name: 'Ana' })
    const h = await header(root)
    const slot = h.querySelector<HTMLSlotElement>('slot[name="title"]')
    expect(slot?.assignedNodes()).toEqual([])
    expect(slot?.assignedNodes({ flatten: true })).toEqual([h.querySelector('.file')])
  })

  it('marks the header, editor and comments regions as parts', async () => {
    const root = place({ name: 'Ana' })
    await header(root)
    expect(root.querySelector('.review-header')?.getAttribute('part')).toBe('header')
    expect(root.querySelector('main.editor')?.getAttribute('part')).toBe('editor')
    expect(root.querySelector('.comments-host')?.getAttribute('part')).toBe('comments')
  })

  it('renders the Japanese join form, and a label override', async () => {
    const ja = place({ lang: 'ja' })
    expect(ja.querySelector('form button')?.textContent).toBe('参加')
    document.body.replaceChildren()
    const over = place({ labels: '{"join":"Enter"}' })
    expect(over.querySelector('form button')?.textContent).toBe('Enter')
  })

  it('falls back to English with invalid labels JSON, without throwing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = place({ labels: '{oops' })
    expect(root.querySelector('form button')?.textContent).toBe('Join')
  })

  it('translates errors and speaks the status in a live region', async () => {
    location.hash = ''
    const bad = place({ lang: 'ja' })
    expect(bad.querySelector('[role="alert"]')?.textContent).toBe(
      'レビュー用のリンクではありません。',
    )
    document.body.replaceChildren()
    location.hash = `#${ID}.${generateEditSecret()}`
    const root = place({ name: 'Ana', labels: '{"live":"All good"}' })
    await vi.waitFor(() => {
      const s = root.querySelector('[role="status"]')
      expect(s?.getAttribute('aria-live')).toBe('polite')
      expect(s?.textContent).toBe('All good')
    })
  })
})
