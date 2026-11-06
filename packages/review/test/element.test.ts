// @vitest-environment jsdom

import { deriveRoomKeys, generateEditSecret, parseFragment } from '@pedit/protocol'
import { Relay } from '@pedit/protocol/testing'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextMenu } from '../../web/src/core/menu.ts'
import type { PeditReview } from '../src/element.ts'

// Before any import runs: every way into the page's storage counts.
const storage = vi.hoisted(() => {
  const touched: string[] = []
  const trap = (name: string) => () => {
    touched.push(name)
    throw new Error(`storage touched: ${name}`)
  }
  for (const target of [globalThis, window]) {
    Object.defineProperty(target, 'localStorage', { configurable: true, get: trap('localStorage') })
    Object.defineProperty(target, 'sessionStorage', {
      configurable: true,
      get: trap('sessionStorage'),
    })
  }
  for (const method of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const)
    Storage.prototype[method] = trap(method) as never
  return { touched }
})

const ID = 'a'.repeat(22)
const hash = () => `#${ID}.${generateEditSecret()}`

beforeAll(async () => {
  // Imported only now: the element and its libraries load with the traps set.
  await import('../src/index.ts')
  // jsdom lays nothing out; CodeMirror measures text ranges.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
})

let relay: Relay
beforeEach(() => {
  relay = new Relay()
  ;(customElements.get('pedit-review') as typeof PeditReview).testing = {
    createSocket: relay.create,
  }
  location.hash = hash()
})

afterEach(async () => {
  document.body.replaceChildren()
  await vi.waitFor(() => expect(open()).toBe(0))
  vi.restoreAllMocks()
  location.hash = ''
})

/** Sockets the relay holds that are not closed yet. */
const open = () => [...relay.sockets].filter((s) => s.readyState !== 3).length

function place(attrs: Record<string, string> = { relay: 'https://relay.test', name: 'Ana' }) {
  const el = document.createElement('pedit-review') as PeditReview
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  const events: { type: string; detail: Record<string, string> }[] = []
  for (const type of ['pedit-status', 'pedit-error'])
    document.body.addEventListener(type, (e) =>
      events.push({ type, detail: (e as CustomEvent).detail }),
    )
  document.body.append(el)
  return { el, events, root: el.shadowRoot as ShadowRoot }
}

const statuses = (events: { type: string; detail: Record<string, string> }[]) =>
  events.filter((e) => e.type === 'pedit-status').map((e) => e.detail.status)

describe('<pedit-review>', () => {
  it('mounts into its shadow root only, and reports connecting then live', async () => {
    const { el, events, root } = place()
    await vi.waitFor(() => expect(statuses(events)).toEqual(['connecting', 'live']))
    expect(el.children.length).toBe(0)
    expect(root.querySelector('.cm-editor')).not.toBeNull()
    expect(root.querySelector('.review-header')).not.toBeNull()
    expect(relay.urls[0]).toBe(`wss://relay.test/api/rooms/${ID}/ws`)
  })

  it('shows the access of a link below edit', async () => {
    const link = parseFragment(generateEditSecret())
    if (!link) throw new Error('no link')
    const keys = await deriveRoomKeys(link, ID)
    location.hash = `#${ID}.${keys.fragments.read}`
    const { root } = place()
    await vi.waitFor(() => expect(root.querySelector('.access')?.textContent).toBe('Read only'))
  })

  it.each([
    ['no relay', { name: 'Ana' }],
    ['a relay that is not http(s)', { relay: 'ftp://relay.test', name: 'Ana' }],
    ['a relay that is not a URL', { relay: 'relay', name: 'Ana' }],
  ])('says so and opens nothing with %s', async (_, attrs) => {
    const { events, root } = place(attrs)
    await vi.waitFor(() => expect(events.map((e) => e.detail.reason)).toEqual(['missing-relay']))
    expect(root.querySelector('[role="alert"]')?.textContent).toMatch(/relay/)
    expect(relay.urls).toEqual([])
  })

  it.each(['', '#nothing', `#${ID}.short`])(
    'says so and opens nothing for the link %j',
    async (h) => {
      location.hash = h
      const { events, root } = place()
      await vi.waitFor(() => expect(events.map((e) => e.detail.reason)).toEqual(['bad-link']))
      expect(root.querySelector('[role="alert"]')?.textContent).toMatch(/review link/)
      expect(relay.urls).toEqual([])
    },
  )

  it('asks for a name when the attribute is missing, and joins with the typed one', async () => {
    const { events, root } = place({ relay: 'https://relay.test' })
    const input = await vi.waitFor(() => {
      const found = root.querySelector<HTMLInputElement>('form input[name="name"]')
      expect(found).not.toBeNull()
      return found as HTMLInputElement
    })
    expect(relay.urls).toEqual([])
    input.value = '  Bo  '
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }))
    await vi.waitFor(() => expect(statuses(events)).toContain('live'))
    expect(root.querySelector('form')).toBeNull()
    const names = [...root.querySelectorAll('.people li')].map((li) => li.textContent)
    expect(names.join()).toContain('Bo')
  })

  it('skips the form with a name attribute', async () => {
    const { events, root } = place()
    await vi.waitFor(() => expect(statuses(events)).toContain('live'))
    expect(root.querySelector('form')).toBeNull()
  })

  it('never touches the page storage, loading or running', async () => {
    const { events } = place({ relay: 'https://relay.test', name: 'Ana' })
    await vi.waitFor(() => expect(statuses(events)).toContain('live'))
    expect(storage.touched).toEqual([])
  })

  it('closes the socket even when a disposer throws', async () => {
    const { el, events } = place()
    await vi.waitFor(() => expect(statuses(events)).toContain('live'))
    vi.spyOn(ContextMenu.prototype, 'dispose').mockImplementation(() => {
      throw new Error('boom')
    })
    el.remove()
    await vi.waitFor(() => expect(open()).toBe(0))
  })

  it('leaves no socket and no window listener when removed, and mounts again when added back', async () => {
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const { el, events } = place()
    await vi.waitFor(() => expect(statuses(events)).toContain('live'))
    const count = (spy: typeof added, type: string) =>
      spy.mock.calls.filter(([t]) => t === type).length
    el.remove()
    await vi.waitFor(() => expect(open()).toBe(0))
    expect(count(removed, 'hashchange')).toBe(count(added, 'hashchange'))
    const quiet = events.length
    relay.signal('ignored')
    expect(events.length).toBe(quiet)
    expect(el.shadowRoot?.querySelector('.cm-editor')).toBeNull()

    document.body.append(el)
    await vi.waitFor(() => expect(open()).toBeGreaterThan(0))
    expect(el.shadowRoot?.querySelector('.cm-editor')).not.toBeNull()
  })

  it('mounts again with the new link on hashchange', async () => {
    const { events, root } = place()
    await vi.waitFor(() => expect(statuses(events)).toContain('live'))
    const first = relay.urls.length
    location.hash = `#${'b'.repeat(22)}.${generateEditSecret()}`
    await vi.waitFor(() => expect(relay.urls.length).toBe(first + 1))
    expect(relay.urls.at(-1)).toBe(`wss://relay.test/api/rooms/${'b'.repeat(22)}/ws`)
    await vi.waitFor(() => expect(open()).toBe(1))
    expect(root.querySelectorAll('.cm-editor').length).toBe(1)
  })

  it('ignores a hash that is not a link while a room is open, and the same link again', async () => {
    const { events } = place()
    await vi.waitFor(() => expect(statuses(events)).toContain('live'))
    const sockets = relay.urls.length
    const same = location.hash
    location.hash = '#section'
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    location.hash = ''
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    location.hash = same
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await new Promise((r) => setTimeout(r, 20))
    expect(relay.urls.length).toBe(sockets)
    expect(events.filter((e) => e.type === 'pedit-error')).toEqual([])
  })

  it('opens a valid link that arrives after a bad one', async () => {
    location.hash = ''
    const { events } = place()
    await vi.waitFor(() => expect(events.map((e) => e.detail.reason)).toEqual(['bad-link']))
    location.hash = hash()
    await vi.waitFor(() => expect(statuses(events)).toContain('live'))
  })

  it('defines the element once however many copies load', async () => {
    const define = vi.spyOn(customElements, 'define')
    vi.resetModules()
    await import('../src/index.ts')
    expect(define).not.toHaveBeenCalled()
  })
})
