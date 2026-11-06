// @vitest-environment jsdom

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  deriveRoomKeys,
  generateEditSecret,
  HOST_AWAY,
  parseFragment,
  ROOM_CLOSED,
} from '@pedit/protocol'
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

/** Declarations `--name: value` of the block with exactly this selector. */
function block(css: string, selector: string) {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = plain.indexOf(`${selector} {`)
  const body = at < 0 ? '' : plain.slice(at, plain.indexOf('}', at))
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], (m[2] ?? '').trim()]),
  ) as Record<string, string>
}

describe('host.css variables', () => {
  const base = block(hostCss, '\n:host')
  const dark = block(hostCss, ':host(:not([scheme="light"]))')
  const forced = block(hostCss, ':host([scheme="dark"])')

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

describe('scheme', () => {
  const base = block(hostCss, '\n:host')
  const dark = block(hostCss, ':host(:not([scheme="light"]))')
  const forced = block(hostCss, ':host([scheme="dark"])')

  it('applies the media dark block to auto and dark, never to light', () => {
    expect(hostCss).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:host\(:not\(\[scheme="light"\]\)\)/,
    )
    expect(hostCss).toMatch(/:host\(\[scheme="light"\]\) \{\s*color-scheme: light;\s*\}/)
    expect(hostCss).toMatch(/:host\(\[scheme="dark"\]\) \{\s*color-scheme: dark;/)
    expect(Object.keys(block(hostCss, ':host([scheme="light"])')).length).toBe(0)
  })

  it('sets the same dark defaults under scheme=dark as under the media query', () => {
    expect(forced).toEqual(dark)
    expect(forced['--bg']).toBe('var(--pedit-bg, #0d1117)')
    expect(base['--bg']).toBe('var(--pedit-bg, #fff)')
  })
})

describe('resolveLabels', () => {
  it('defaults to English, takes ja and a region of it, and ignores unknown languages', () => {
    expect(resolveLabels(null, null).join).toBe('Join')
    expect(resolveLabels('ja', null).join).toBe('参加')
    expect(resolveLabels('ja-JP', null).join).toBe('参加')
    expect(resolveLabels('fr', null).join).toBe('Join')
  })

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'falls back to English for lang=%s',
    (lang) => {
      expect(resolveLabels(lang, null)).toEqual(resolveLabels('en', null))
    },
  )

  it('is not changed by a __proto__ payload', () => {
    const l = resolveLabels('en', '{"__proto__":{"join":"x"},"constructor":"y"}')
    expect(l).toEqual(resolveLabels('en', null))
    expect(({} as Record<string, unknown>).join).toBeUndefined()
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

  it('keeps the file name beside the title slot', async () => {
    const title = slotted('span', 'title', 'My doc')
    const root = place({ name: 'Ana' }, [title])
    await vi.waitFor(() => expect(root.querySelector('.file')).not.toBeNull())
    const h = await header(root)
    const kids = [...h.children].map((c) => c.getAttribute('name') ?? c.className)
    expect(kids.slice(0, 3)).toEqual(['logo', 'title', 'file'])
  })

  it.each([
    ['the join form', { relay: 'https://relay.test' }, ''],
    ['an error', { name: 'Ana' }, 'bad'],
  ])('shows the header slots in %s', (_, attrs, bad) => {
    if (bad) location.hash = ''
    const logo = slotted('img', 'logo', '')
    const root = place(attrs, [logo])
    const slot = root.querySelector<HTMLSlotElement>('.review-header slot[name="logo"]')
    expect(slot?.assignedNodes()).toEqual([logo])
    expect(root.querySelector('.review-header slot[name="title"]')).not.toBeNull()
  })

  it('takes lang from the element, else the nearest ancestor, else English', () => {
    const wrap = document.createElement('div')
    wrap.lang = 'ja'
    document.body.append(wrap)
    const el = document.createElement('pedit-review')
    el.setAttribute('relay', 'https://relay.test')
    wrap.append(el)
    expect(el.shadowRoot?.querySelector('form button')?.textContent).toBe('参加')
    wrap.replaceChildren()
    const own = document.createElement('pedit-review')
    own.setAttribute('relay', 'https://relay.test')
    own.setAttribute('lang', 'en')
    wrap.append(own)
    expect(own.shadowRoot?.querySelector('form button')?.textContent).toBe('Join')
    wrap.remove()
    expect(place({}).querySelector('form button')?.textContent).toBe('Join')
  })

  it('translates the access labels', async () => {
    const link = parseFragment(generateEditSecret())
    if (!link) throw new Error('no link')
    const keys = await deriveRoomKeys(link, ID)
    for (const [frag, text, title] of [
      [keys.fragments.read, '閲覧のみ', 'このファイルを読めます。'],
      [keys.fragments.comment, 'コメントのみ', 'このファイルを読み、コメントできます。'],
    ] as const) {
      document.body.replaceChildren()
      location.hash = `#${ID}.${frag}`
      const root = place({ name: 'Ana', lang: 'ja' })
      await vi.waitFor(() => {
        expect(root.querySelector('.access')?.textContent).toBe(text)
        expect(root.querySelector<HTMLElement>('.access')?.title).toBe(title)
      })
    }
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

  it('speaks connecting, the host being away, and the end', async () => {
    const root = place({ name: 'Ana', lang: 'ja' })
    const said = () => root.querySelector('[role="status"]')?.textContent
    // `connecting` passes too fast to wait for: record what the line said.
    const seen: string[] = []
    new MutationObserver(() => {
      const t = said()
      if (t && seen.at(-1) !== t) seen.push(t)
    }).observe(root, { childList: true, subtree: true, characterData: true })
    await vi.waitFor(() => expect(said()).toBe('接続しました'))
    expect(seen[0]).toBe('接続中')
    relay.signal(HOST_AWAY)
    await vi.waitFor(() => expect(said()).toBe('ホストが離席中です'))
    relay.closeAll(ROOM_CLOSED)
    await vi.waitFor(() => expect(said()).toBe('レビューは終了しました'))
  })
})
