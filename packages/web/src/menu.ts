import { render } from '@barefootjs/client/runtime'
import { Store } from './core/store.ts'
import './components/Menu.tsx'

export interface MenuItem {
  label: string
  /** The keys that do the same, like ['Mod', 'Alt', '=']; shown on the right. */
  keys?: readonly string[]
  disabled?: boolean
  action: () => void
}

/** A separator between groups of items. */
export const SEPARATOR = null

const EDGE = 8

/** Whether shortcuts read ⌘ and ⌥ rather than Ctrl and Alt. */
export function isMac(nav: Pick<Navigator, 'userAgent'> = navigator): boolean {
  return /Mac|iPhone|iPad/.test(nav.userAgent)
}

/** A shortcut as this platform writes it, from keys like ['Mod', 'Alt', '=']. */
export function formatShortcut(keys: readonly string[], mac = isMac()): string {
  const names: Record<string, [string, string]> = {
    Mod: ['⌘', 'Ctrl'],
    Alt: ['⌥', 'Alt'],
    Shift: ['⇧', 'Shift'],
  }
  const parts = keys.map((k) => names[k]?.[mac ? 0 : 1] ?? k)
  return mac ? parts.join('') : parts.join('+')
}

/** The same keys as aria-keyshortcuts wants them: KeyboardEvent.key names joined by +. */
export function ariaShortcut(keys: readonly string[], mac = isMac()): string {
  const names: Record<string, [string, string]> = { Mod: ['Meta', 'Control'] }
  return keys.map((k) => names[k]?.[mac ? 0 : 1] ?? k).join('+')
}

/** A menu row as the component draws it (components/Menu.tsx). */
export type MenuEntry =
  | { separator: true }
  | { separator: false; label: string; kbd?: string; aria?: string; disabled: boolean }

export interface MenuState {
  open: boolean
  entries: readonly MenuEntry[]
  left: number
  top: number
}

/**
 * A context menu at a point. It closes on Escape, Tab, a pick, or a press
 * anywhere else, and gives the focus back to where it was. This class keeps
 * the state and the behaviour; Menu.tsx draws it inside `element`.
 */
export class ContextMenu {
  readonly element: HTMLElement
  readonly state = new Store<MenuState>({ open: false, entries: [], left: 0, top: 0 })
  #mac: boolean
  #actions: ((() => void) | null)[] = []
  #returnFocus: HTMLElement | null = null
  // Inside a shadow root the target is retargeted to the host, so ask the path.
  #onOutside = (ev: Event) => {
    if (!ev.composedPath().includes(this.element)) this.close()
  }

  constructor(mac = isMac()) {
    this.#mac = mac
    this.element = document.createElement('div')
    this.element.className = 'menu-slot'
    render(this.element, 'Menu', { menu: this })
  }

  get open(): boolean {
    return this.state.get().open
  }

  show(items: readonly (MenuItem | null)[], x: number, y: number): void {
    this.#returnFocus = this.#active() as HTMLElement | null
    this.#actions = items.map((item) => item?.action ?? null)
    const entries: MenuEntry[] = items.map((item) =>
      item
        ? {
            separator: false,
            label: item.label,
            kbd: item.keys && formatShortcut(item.keys, this.#mac),
            aria: item.keys && ariaShortcut(item.keys, this.#mac),
            disabled: item.disabled ?? false,
          }
        : { separator: true },
    )
    this.state.set({ open: true, entries, left: x, top: y })
    // Keep it on screen: flip left or up when it would overflow.
    const menu = this.element.querySelector<HTMLElement>('.context-menu')
    const { width, height } = menu?.getBoundingClientRect() ?? { width: 0, height: 0 }
    const root = this.element.ownerDocument.documentElement
    const vw = root.clientWidth
    const vh = root.clientHeight
    const left = x + width + EDGE > vw ? Math.max(EDGE, x - width) : x
    const top = y + height + EDGE > vh ? Math.max(EDGE, y - height) : y
    this.state.set({ open: true, entries, left, top })
    this.element.ownerDocument.addEventListener('pointerdown', this.#onOutside, true)
    this.#items()[0]?.focus()
  }

  close(): void {
    if (!this.open) return
    this.state.set({ ...this.state.get(), open: false })
    this.element.ownerDocument.removeEventListener('pointerdown', this.#onOutside, true)
    const back = this.#returnFocus
    this.#returnFocus = null
    if (back?.isConnected) back.focus()
  }

  /** Runs the item at `index` in the list shown, after closing. */
  pick(index: number): void {
    const action = this.#actions[index]
    this.close()
    action?.()
  }

  /** The focused element in the document or shadow root the menu is in. */
  #active(): Element | null {
    const root = this.element.getRootNode() as Document | ShadowRoot
    return (root.activeElement ?? this.element.ownerDocument.activeElement) as Element | null
  }

  #items(): HTMLButtonElement[] {
    return [...this.element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(
      (b) => !b.disabled,
    )
  }

  onKey(ev: KeyboardEvent): void {
    const items = this.#items()
    const at = items.indexOf(this.#active() as HTMLButtonElement)
    const target =
      ev.key === 'ArrowDown'
        ? items[(at + 1) % items.length]
        : ev.key === 'ArrowUp'
          ? items[(at - 1 + items.length) % items.length]
          : ev.key === 'Home'
            ? items[0]
            : ev.key === 'End'
              ? items.at(-1)
              : undefined
    if (target) {
      ev.preventDefault()
      target.focus()
    } else if (ev.key === 'Escape' || ev.key === 'Tab') {
      ev.preventDefault()
      this.close()
    }
    // Keys stay in the menu, not the grid under it.
    ev.stopPropagation()
  }
}
