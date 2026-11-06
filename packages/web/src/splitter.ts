import { render } from '@barefootjs/client/runtime'
import { Store as Value } from './core/store.ts'
import { defaultStore, type Store } from './storage.ts'
import './components/SplitterBar.tsx'

export const SPLIT_KEY = 'pedit:split'
export const MIN_RATIO = 0.2
export const MAX_RATIO = 0.8
const DEFAULT_RATIO = 0.5
const STEP = 0.05

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_RATIO
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

/** The editor's share of the width at a pointer position inside the container. */
export function ratioAt(x: number, rect: Pick<DOMRect, 'left' | 'width'>): number {
  return rect.width > 0 ? clampRatio((x - rect.left) / rect.width) : DEFAULT_RATIO
}

export function loadSplitRatio(store: Store | null = defaultStore()): number {
  try {
    const value = store?.getItem(SPLIT_KEY)
    return value ? clampRatio(Number(value)) : DEFAULT_RATIO
  } catch {
    return DEFAULT_RATIO
  }
}

export function saveSplitRatio(ratio: number, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(SPLIT_KEY, String(Math.round(ratio * 1000) / 1000))
  } catch {
    // Private mode or storage disabled: the width lasts for this page only.
  }
}

/**
 * The divider between the editor and the preview in Split. Drag it, use the
 * arrow keys, or double-click to go back to half and half. The editor's share
 * is exposed to CSS as `--split` on the container.
 */
export class Splitter {
  /** Holds the divider (components/SplitterBar.tsx). */
  readonly element: HTMLElement
  /** The editor's share of the width, in percent, as the divider announces it. */
  readonly percent = new Value(0)
  #container: HTMLElement
  #ratio: number
  #store: Store | null
  #onResize: () => void

  constructor(
    container: HTMLElement,
    options: { store?: Store | null; onResize?: () => void } = {},
  ) {
    this.#container = container
    this.#store = options.store === undefined ? defaultStore() : options.store
    this.#onResize = options.onResize ?? (() => {})
    this.#ratio = loadSplitRatio(this.#store)
    this.#show()
    this.element = document.createElement('div')
    this.element.className = 'splitter-slot'
    render(this.element, 'SplitterBar', { splitter: this })
  }

  get ratio(): number {
    return this.#ratio
  }

  onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0) return
    ev.preventDefault()
    // Keeps the drag going over the preview's iframes.
    ;(ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId)
    this.#container.dataset.resizing = ''
  }

  onPointerMove(ev: PointerEvent): void {
    if (!('resizing' in this.#container.dataset)) return
    this.#set(ratioAt(ev.clientX, this.#container.getBoundingClientRect()), false)
  }

  onPointerEnd(): void {
    if (!('resizing' in this.#container.dataset)) return
    delete this.#container.dataset.resizing
    saveSplitRatio(this.#ratio, this.#store)
  }

  /** Back to half and half. */
  reset(): void {
    this.#set(DEFAULT_RATIO, true)
  }

  onKey(ev: KeyboardEvent): void {
    const next =
      ev.key === 'ArrowLeft'
        ? this.#ratio - STEP
        : ev.key === 'ArrowRight'
          ? this.#ratio + STEP
          : ev.key === 'Home'
            ? MIN_RATIO
            : ev.key === 'End'
              ? MAX_RATIO
              : null
    if (next === null) return
    ev.preventDefault()
    this.#set(next, true)
  }

  #set(ratio: number, save: boolean): void {
    this.#ratio = clampRatio(ratio)
    this.#show()
    if (save) saveSplitRatio(this.#ratio, this.#store)
    this.#onResize()
  }

  #show(): void {
    const percent = Math.round(this.#ratio * 1000) / 10
    this.#container.style.setProperty('--split', `${percent}%`)
    this.percent.set(percent)
  }
}
