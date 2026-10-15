// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../src/components/Settings.tsx'
import { galleryTarget, panelBox } from '../src/settings.ts'
import { THEMES, themeInfo } from '../src/themes.ts'
import { fakeSettings } from './support/settings-model.ts'

const mounted: HTMLElement[] = []
afterEach(() => {
  for (const el of mounted.splice(0)) el.remove()
})

function mount(options: Parameters<typeof fakeSettings>[0] = {}) {
  const fake = fakeSettings(options)
  const container = document.createElement('div')
  document.body.append(container)
  mounted.push(container)
  render(container, 'Settings', { model: fake.model })
  // jsdom has no showPopover(), and since 30.1.2 it does not focus inside a
  // closed popover, as browsers don't. Show the panel as an open one would be.
  container.querySelector<HTMLElement>('[popover]')?.style.setProperty('display', 'block')
  const q = <T extends Element = HTMLElement>(sel: string) => {
    const el = container.querySelector<T>(sel)
    if (!el) throw new Error(`no ${sel}`)
    return el
  }
  const field = (label: string) => {
    const el = [...container.querySelectorAll<HTMLElement>('.settings-field, .settings-row')].find(
      (f) =>
        (f.querySelector('.settings-text > span') ?? f.querySelector(':scope > span'))
          ?.textContent === label,
    )
    if (!el) throw new Error(`no ${label}`)
    return el
  }
  const input = (label: string) => field(label).querySelector('input, select') as HTMLInputElement
  const box = () => q('[role=listbox]')
  const selected = () =>
    box().querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.value ?? null
  const press = (key: string, target: HTMLElement = box()) => {
    const ev = new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true })
    target.dispatchEvent(ev)
    return ev
  }
  const openPanel = () => {
    const ev = new Event('beforetoggle') as Event & { newState: string }
    ev.newState = 'open'
    q('.settings').dispatchEvent(ev)
  }
  return { ...fake, container, q, field, input, box, selected, press, openPanel }
}

describe('Settings', () => {
  it('opens its panel from a labelled gear button', () => {
    const { q } = mount()
    const button = q<HTMLButtonElement>('button.icon')
    const panel = q('.settings')
    expect(button.getAttribute('aria-label')).toBe('Settings')
    expect(button.getAttribute('popovertarget')).toBe(panel.id)
    expect(panel.hasAttribute('popover')).toBe(true)
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('lists the sections in order', () => {
    const { container } = mount()
    const sections = [...container.querySelectorAll('.settings-section')].map((s) => s.textContent)
    expect(sections).toEqual(['Appearance', 'Text', 'Editor'])
  })

  it('reports toggles, and follows the model when it changes or puts a toggle back', () => {
    const { input, calls, stores } = mount()
    const wrap = input('Wrap long lines')
    expect(wrap.checked).toBe(true)
    wrap.checked = false
    wrap.dispatchEvent(new Event('change'))
    expect(calls).toEqual([['wrap', false]])
    stores.wrap.set(true)
    expect(wrap.checked).toBe(true)
  })

  it('puts the Vim toggle back when the mode fails to load', async () => {
    const { input, calls, field } = mount({ vimFails: true })
    const vim = input('Vim keybindings')
    expect(field('Vim keybindings').querySelector('small')?.textContent).toBe(
      'Only in this browser.',
    )
    vim.checked = true
    vim.dispatchEvent(new Event('change'))
    expect(calls).toEqual([['vim', true]])
    await vi.waitFor(() => expect(vim.checked).toBe(false))
  })

  it('reports every step of a range with a formatted value', () => {
    const { input, field, calls } = mount()
    const size = input('Font size')
    expect(size.min).toBe('12')
    expect(size.max).toBe('24')
    expect(size.value).toBe('15')
    expect(field('Font size').querySelector('output')?.textContent).toBe('15px')
    size.value = '18'
    size.dispatchEvent(new Event('input'))
    expect(calls).toEqual([['fontSize', 18]])
    expect(field('Font size').querySelector('output')?.textContent).toBe('18px')
    expect(field('Line height').querySelector('output')?.textContent).toBe('1.6')
  })
})

describe('Settings theme gallery', () => {
  const light = THEMES.filter((t) => t.scheme === 'light')
  const dark = THEMES.filter((t) => t.scheme === 'dark')

  it('shows only the current theme on the settings page', () => {
    const { q } = mount({ theme: 'dracula' })
    const row = q<HTMLButtonElement>('.settings-nav')
    expect(q('.settings-home').hidden).toBe(false)
    expect(q('.settings-page').hidden).toBe(true)
    expect(row.getAttribute('aria-label')).toBe('Theme: Dracula')
    expect(row.getAttribute('aria-haspopup')).toBe('listbox')
    expect(q('.settings-nav-value').textContent).toBe('Dracula')
    expect(row.querySelector('.theme-preview')).not.toBeNull()
  })

  it('opens a page of cards in place of the settings, with the list focused', () => {
    const { q, box, selected } = mount({ theme: 'dracula' })
    q<HTMLButtonElement>('.settings-nav').click()
    expect(q('.settings-home').hidden).toBe(true)
    expect(q('.settings-page').hidden).toBe(false)
    expect(document.activeElement).toBe(box())
    expect(selected()).toBe('dracula')
    const labels = [...box().querySelectorAll('.settings-group-label')].map((l) => l.textContent)
    expect(labels).toEqual(['Light', 'Dark'])
    expect(box().querySelectorAll('[role=option]')).toHaveLength(THEMES.length)
    expect(box().getAttribute('aria-activedescendant')).toBe('settings-theme-dracula')
  })

  it('applies each theme as the arrow keys reach it, across groups, and updates the row', () => {
    const last = light.at(-1)?.id as string
    const { q, press, calls, selected } = mount({ theme: last })
    q<HTMLButtonElement>('.settings-nav').click()
    press('ArrowDown')
    expect(selected()).toBe(dark[0]?.id)
    press('ArrowUp')
    press('Home')
    expect(calls).toEqual([
      ['theme', dark[0]?.id],
      ['theme', last],
      ['theme', light[0]?.id],
    ])
    expect(q('.settings-nav').getAttribute('aria-label')).toBe(`Theme: ${light[0]?.label}`)
  })

  it('applies a theme on click, stays open to compare, and ignores the current one', () => {
    const { q, box, calls, selected } = mount({ theme: 'dracula' })
    q<HTMLButtonElement>('.settings-nav').click()
    box().querySelector<HTMLElement>('[data-value="github-dark"]')?.click()
    box().querySelector<HTMLElement>('[data-value="github-dark"]')?.click()
    expect(calls).toEqual([['theme', 'github-dark']])
    expect(selected()).toBe('github-dark')
    expect(q('.settings-page').hidden).toBe(false)
  })

  it('draws each card in its own theme colours', () => {
    const { box } = mount()
    const dracula = themeInfo('dracula')
    const card = box().querySelector<HTMLElement>('[data-value="dracula"] .theme-preview')
    expect(card?.getAttribute('aria-hidden')).toBe('true')
    expect(card?.style.getPropertyValue('--tp-panel')).toBe(dracula?.page.panel)
    expect(card?.style.getPropertyValue('--tp-accent')).toBe(dracula?.page.accent)
    const looks = [...box().querySelectorAll<HTMLElement>('.theme-preview')].map((el) =>
      ['--tp-panel', '--tp-ink', '--tp-accent'].map((n) => el.style.getPropertyValue(n)).join(),
    )
    expect(new Set(looks).size).toBe(THEMES.length)
  })

  it('goes back with Enter, Escape or the back button, focusing the row', () => {
    const { q, press } = mount()
    const row = q<HTMLButtonElement>('.settings-nav')
    for (const back of [
      () => press('Enter'),
      () => press('Escape'),
      () => q<HTMLButtonElement>('.settings-back').click(),
    ]) {
      row.click()
      back()
      expect(q('.settings-home').hidden).toBe(false)
      expect(q('.settings-page').hidden).toBe(true)
      expect(document.activeElement).toBe(row)
    }
    expect(q('.settings-back').getAttribute('aria-label')).toBe('Back to settings')
    // Escape on the settings themselves is left to the popover.
    expect(press('Escape', row).defaultPrevented).toBe(false)
  })

  it('opens on the settings again after the panel closed on the gallery', () => {
    const { q, openPanel } = mount()
    q<HTMLButtonElement>('.settings-nav').click()
    openPanel()
    expect(q('.settings-home').hidden).toBe(false)
    expect(q('.settings-page').hidden).toBe(true)
  })

  it('follows the model when the theme changes elsewhere, preview included', () => {
    const { stores, selected, q } = mount()
    stores.theme.set('dracula')
    expect(selected()).toBe('dracula')
    expect(q('.settings-nav').getAttribute('aria-label')).toBe('Theme: Dracula')
    const preview = q('.settings-nav-preview .theme-preview')
    expect(preview.style.getPropertyValue('--tp-panel')).toBe(themeInfo('dracula')?.page.panel)
  })
})

describe('galleryTarget', () => {
  it.each([
    ['ArrowDown', 1, 2],
    ['ArrowRight', 3, 3],
    ['ArrowUp', 0, 0],
    ['ArrowLeft', 2, 1],
    ['Home', 2, 0],
    ['End', 0, 3],
    ['a', 1, null],
  ])('%s from %i -> %j', (key, at, expected) => {
    expect(galleryTarget(key, at, 4)).toBe(expected)
  })
})

describe('panelBox', () => {
  it('lines the panel up with the right edge of the gear', () => {
    expect(panelBox({ right: 1270, bottom: 40 }, 1280)).toMatchObject({
      left: 950,
      top: 46,
      width: 320,
    })
  })

  it('scrolls inside the panel rather than running off the bottom', () => {
    expect(panelBox({ right: 1270, bottom: 40 }, 1280).maxHeight).toBe(
      'calc(var(--app-height, 100dvh) - 54px)',
    )
  })

  it('keeps the panel on screen when the gear wraps to the left', () => {
    expect(panelBox({ right: 250, bottom: 80 }, 375)).toMatchObject({ left: 8, width: 320 })
    expect(panelBox({ right: 300, bottom: 80 }, 250)).toMatchObject({ left: 8, width: 234 })
  })

  it('is applied when the panel opens', () => {
    const { q, openPanel } = mount()
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1280,
    })
    q('button.icon').getBoundingClientRect = () => ({ right: 1270, bottom: 40 }) as DOMRect
    openPanel()
    expect(q('.settings').style).toMatchObject({ left: '950px', top: '46px', width: '320px' })
  })
})
