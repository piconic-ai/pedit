// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../src/components/Cards.tsx'
import '../src/components/Layout.tsx'
import type { LayoutParts } from '../src/components/Layout.tsx'

const mounted: HTMLElement[] = []
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove()
})

function mount(name: string, props: Record<string, unknown> = {}) {
  const container = document.createElement('div')
  document.body.append(container)
  mounted.push(container)
  render(container, name, props)
  return container
}

describe('Landing', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const shown = (el: Element | null) => el?.querySelector('[aria-hidden="true"]')?.textContent

  it('introduces pedit and links to the repository', () => {
    const el = mount('Landing')
    expect(el.querySelector('h1 .visually-hidden')?.textContent).toBe('pedit')
    expect(el.querySelector('p .visually-hidden')?.textContent).toBe('Pair edit your local files.')
    const link = el.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://github.com/piconic-ai/pedit')
    expect(link?.getAttribute('aria-label')).toBe('GitHub')
    expect(link?.querySelector('svg')).not.toBeNull()
  })

  it('types the name and corrects the tagline, one caret each', () => {
    vi.useFakeTimers()
    const el = mount('Landing')
    const h1 = el.querySelector('h1')
    const p = el.querySelector('p')
    expect(el.querySelectorAll('.peer-caret')).toHaveLength(2)
    expect(el.querySelector('h1 .untyped')?.textContent).toBe('pedit')
    expect(shown(p)).toBe('Pair edit your remote files.')
    vi.advanceTimersByTime(1000)
    expect(el.querySelector('p .word')?.hasAttribute('data-selected')).toBe(true)
    vi.advanceTimersByTime(4000)
    expect(el.querySelector('p .word')?.hasAttribute('data-selected')).toBe(false)
    expect(el.querySelector('.landing')?.hasAttribute('data-done')).toBe(true)
    expect(el.querySelector('h1 .untyped')?.textContent).toBe('')
    expect(shown(h1)).toBe('pedit')
    expect(shown(p)).toBe('Pair edit your local files.')
  })

  it('shows the finished page at once under reduced motion', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce') }))
    const el = mount('Landing')
    expect(shown(el.querySelector('h1'))).toBe('pedit')
    expect(shown(el.querySelector('p'))).toBe('Pair edit your local files.')
  })
})

describe('IncompleteLink', () => {
  it('gently invites reopening the full shared URL', () => {
    const el = mount('IncompleteLink')
    expect(el.querySelector('h1')?.textContent).toBe('Open your shared link again')
    expect(el.textContent).toContain('Please open the full URL you received again')
    expect(el.textContent).toContain('including the part after #')
  })
})

describe('JoinCard', () => {
  function join() {
    const onJoin = vi.fn()
    const el = mount('JoinCard', { onJoin })
    const input = el.querySelector('input') as HTMLInputElement
    const form = el.querySelector('form') as HTMLFormElement
    const submit = (value: string) => {
      input.value = value
      form.dispatchEvent(new Event('submit', { cancelable: true }))
    }
    return { el, input, onJoin, submit }
  }

  it('focuses a name field that fits autofill', () => {
    const { input } = join()
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('autocomplete')).toBe('name')
    expect(input.required).toBe(true)
    expect(input.maxLength).toBe(40)
  })

  it('joins with the trimmed name, and not with a blank one', () => {
    const { onJoin, submit } = join()
    submit('   ')
    expect(onJoin).not.toHaveBeenCalled()
    submit('  Ada  ')
    expect(onJoin).toHaveBeenCalledWith('Ada')
  })
})

describe('Layout', () => {
  it('hands over the room page parts, in page order', () => {
    let parts: LayoutParts | undefined
    const el = mount('Layout', { onReady: (p: LayoutParts) => (parts = p) })
    expect(parts).toBeDefined()
    const p = parts as LayoutParts
    expect(p.main.tagName).toBe('MAIN')
    expect(p.main.className).toBe('editor')
    expect(p.preview.getAttribute('aria-label')).toBe('Preview')
    const order = [...(el.querySelector('.layout')?.querySelectorAll('*') ?? [])]
    const at = (node: HTMLElement) => order.indexOf(node)
    expect([p.header, p.banner, p.main, p.source, p.splitter, p.preview, p.table].map(at)).toEqual(
      [...[p.header, p.banner, p.main, p.source, p.splitter, p.preview, p.table].map(at)].sort(
        (a, b) => a - b,
      ),
    )
  })
})

describe('UnsupportedBrowser', () => {
  it('asks to update a browser that cannot check signatures', () => {
    const el = mount('UnsupportedBrowser')
    expect(el.querySelector('h1')?.textContent).toBe('Update your browser')
    expect(el.querySelector('p')?.textContent).toContain('cannot check who changed the file')
  })
})
