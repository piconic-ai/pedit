import type { ProviderId } from './alwaysload.ts'
import type { Readable } from './store.ts'
import type { ThemeInfo } from './themes.ts'

const PANEL_WIDTH = 320
const EDGE = 8

/** An eight-toothed gear outline centred in a 24x24 box. */
function gearPath(teeth = 8, outer = 10, inner = 7.5): string {
  const points: string[] = []
  const step = (2 * Math.PI) / teeth
  const at = (r: number, a: number) =>
    `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`
  for (let i = 0; i < teeth; i++) {
    const a = i * step
    // Each tooth: rise, flat top, fall; the gap to the next one is a straight edge.
    points.push(
      at(inner, a - step * 0.3),
      at(outer, a - step * 0.18),
      at(outer, a + step * 0.18),
      at(inner, a + step * 0.3),
    )
  }
  return `M${points.join('L')}Z`
}

export const GEAR = gearPath()
export const CHEVRON_RIGHT = 'M9 6l6 6-6 6'
export const CHEVRON_LEFT = 'M15 6l-6 6 6 6'

export interface PanelBox {
  width: number
  left: number
  top: number
  maxHeight: string
}

/**
 * Where the panel opens: right under the gear, wherever the header has
 * wrapped it to, kept on screen and scrolling inside if it is too tall. The
 * info panel opens the same way, narrower.
 */
export function panelBox(
  gear: Pick<DOMRect, 'right' | 'bottom'>,
  viewport: number,
  widest = PANEL_WIDTH,
): PanelBox {
  const width = Math.min(widest, viewport - 2 * EDGE)
  const left = Math.max(EDGE, Math.min(gear.right - width, viewport - width - EDGE))
  const top = gear.bottom + 6
  return { width, left, top, maxHeight: `calc(var(--app-height, 100dvh) - ${top + EDGE}px)` }
}

export interface Range {
  min: number
  max: number
  step: number
}

/**
 * Everything the settings panel (components/Settings.tsx) shows and changes.
 * The values are stores, so a change that fails, such as a theme or the Vim
 * mode that could not load, puts the control back by setting the store again.
 */
export interface SettingsModel {
  themes: readonly ThemeInfo[]
  theme: Readable<string>
  setTheme(id: string): void
  fontSizeRange: Range
  fontSize: Readable<number>
  setFontSize(size: number): void
  lineHeightRange: Range
  lineHeight: Readable<number>
  setLineHeight(height: number): void
  wrap: Readable<boolean>
  setWrap(on: boolean): void
  vim: Readable<boolean>
  setVim(on: boolean): void
  /** The providers whose preview players load without a click, in this browser. */
  alwaysLoad: Readable<readonly ProviderId[]>
  /** Asks again before loading this provider's players; loaded ones stay. */
  forgetAlwaysLoad(id: ProviderId): void
}

/** Where the arrow keys go in the theme gallery, or null for keys it does not handle. */
export function galleryTarget(key: string, at: number, count: number): number | null {
  const last = count - 1
  if (key === 'ArrowDown' || key === 'ArrowRight') return Math.min(last, at + 1)
  if (key === 'ArrowUp' || key === 'ArrowLeft') return Math.max(0, at - 1)
  if (key === 'Home') return 0
  if (key === 'End') return last
  return null
}
