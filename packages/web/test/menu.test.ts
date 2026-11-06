// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ariaShortcut, ContextMenu, formatShortcut, isMac, SEPARATOR } from '../src/menu.ts'

describe('formatShortcut', () => {
  it('writes symbols on a Mac and names elsewhere', () => {
    expect(formatShortcut(['Mod', 'Alt', '='], true)).toBe('⌘⌥=')
    expect(formatShortcut(['Mod', 'Alt', '='], false)).toBe('Ctrl+Alt+=')
    expect(formatShortcut(['Shift', 'Space'], false)).toBe('Shift+Space')
  })

  it('names keys for aria-keyshortcuts as KeyboardEvent.key does', () => {
    expect(ariaShortcut(['Mod', 'Alt', '='], true)).toBe('Meta+Alt+=')
    expect(ariaShortcut(['Mod', 'Alt', '-'], false)).toBe('Control+Alt+-')
  })

  it('tells a Mac from its user agent', () => {
    expect(isMac({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' })).toBe(true)
    expect(isMac({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe(false)
  })
})

describe('ContextMenu', () => {
  function open() {
    const menu = new ContextMenu(false)
    document.body.append(menu.element)
    const first = vi.fn()
    const second = vi.fn()
    menu.show(
      [
        { label: 'First', keys: ['Mod', '1'], action: first },
        SEPARATOR,
        { label: 'Off', disabled: true, action: vi.fn() },
        { label: 'Second', action: second },
      ],
      10,
      10,
    )
    const items = [...menu.element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    return { menu, first, second, items }
  }

  it('lists items with shortcuts and separators, focusing the first', () => {
    const { menu, items } = open()
    expect(items.map((b) => b.textContent)).toEqual(['FirstCtrl+1', 'Off', 'Second'])
    expect(items[0]?.getAttribute('aria-keyshortcuts')).toBe('Control+1')
    expect(menu.element.querySelectorAll('[role="separator"]')).toHaveLength(1)
    expect(document.activeElement).toBe(items[0])
    menu.close()
  })

  it('runs an item after closing', () => {
    const { menu, items, second } = open()
    items[2]?.click()
    expect(menu.open).toBe(false)
    expect(second).toHaveBeenCalledOnce()
  })

  it('skips disabled items with the arrow keys and wraps around', () => {
    const { menu, items } = open()
    const key = (k: string) =>
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    key('ArrowDown')
    expect(document.activeElement).toBe(items[2])
    key('ArrowDown')
    expect(document.activeElement).toBe(items[0])
    key('ArrowUp')
    expect(document.activeElement).toBe(items[2])
    key('Escape')
    expect(menu.open).toBe(false)
  })

  it('closes on a press outside and gives the focus back', () => {
    const before = document.createElement('button')
    document.body.append(before)
    before.focus()
    const { menu } = open()
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    expect(menu.open).toBe(false)
    expect(document.activeElement).toBe(before)
  })

  describe('inside a shadow root', () => {
    function inShadow() {
      const host = document.createElement('div')
      document.body.append(host)
      const shadow = host.attachShadow({ mode: 'open' })
      const before = document.createElement('button')
      shadow.append(before)
      before.focus()
      const menu = new ContextMenu(false)
      shadow.append(menu.element)
      const action = vi.fn()
      menu.show([{ label: 'One', action }], 10, 10)
      const items = [...menu.element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      return { host, shadow, before, menu, items }
    }

    it('stays open on a press on one of its items', () => {
      const { host, menu, items } = inShadow()
      items[0]?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }))
      expect(menu.open).toBe(true)
      menu.close()
      host.remove()
    })

    it('closes on a press outside the host and focuses what was focused in the shadow root', () => {
      const { host, shadow, before, menu } = inShadow()
      expect(shadow.activeElement).not.toBe(before)
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }))
      expect(menu.open).toBe(false)
      expect(shadow.activeElement).toBe(before)
      host.remove()
    })
  })
})
