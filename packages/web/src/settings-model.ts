import { type Compartment, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { AlwaysLoad } from './alwaysload.ts'
import {
  type Appearance,
  applyText,
  fontSizeRange,
  LINE_HEIGHT,
  pageColors,
  resolveTheme,
  saveAppearance,
} from './appearance.ts'
import { applyPalette } from './palette.ts'
import type { SettingsModel } from './settings.ts'
import { Store } from './store.ts'
import { readerTheme, THEMES, type ThemeSwitcher } from './themes.ts'
import type { VimToggle } from './vim.ts'

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function lineWrapping(on: boolean): Extension {
  return on ? EditorView.lineWrapping : []
}

/**
 * The settings panel's model: what it shows, and what each control does to
 * the editor and the page. A change that fails puts the control back.
 */
export function settingsModel(
  editor: EditorView,
  themes: ThemeSwitcher,
  wrapMode: Compartment,
  vim: VimToggle,
  alwaysLoad: AlwaysLoad,
  initial: Appearance,
  fontMode: Compartment,
  /** Other editors on the page, which take the same reader theme. */
  fontFollowers: readonly { view: EditorView; compartment: Compartment }[] = [],
): SettingsModel & { destroy(): void } {
  const prefersDark = matchMedia(DARK_QUERY)
  let current = initial
  const update = (next: Appearance) => {
    current = next
    saveAppearance(next)
  }
  const fontSizes = fontSizeRange(CSS.supports('-webkit-touch-callout', 'none'))
  const theme = new Store(themes.id)
  const fontSize = new Store(Math.max(fontSizes.min, initial.fontSize))
  const lineHeight = new Store(initial.lineHeight)
  const wrap = new Store(initial.wrap)
  const vimOn = new Store(vim.on)

  const showTheme = async () => {
    const id = resolveTheme(current, prefersDark.matches)
    theme.set(id)
    if (id !== themes.id && !(await themes.set(id))) theme.set(themes.id)
    applyPalette(pageColors(current, themes.id))
  }
  // Until the reader picks a theme, the default one follows the OS. Picking is one-way by
  // design: there is one theme, and no "follow the system" entry to go back to (#30).
  const changed = () => void showTheme()
  prefersDark.addEventListener('change', changed)

  const setText = (next: Appearance) => {
    update(next)
    applyText(current)
    // A CSS variable change alone does not make CodeMirror remeasure line
    // heights, so the gutter would drift out of sync with the text (see
    // readerTheme's doc comment in themes.ts). Every editor gets the same
    // instance, so the next call alternates for all of them.
    const reader = readerTheme()
    editor.dispatch({ effects: fontMode.reconfigure(reader) })
    for (const f of fontFollowers) f.view.dispatch({ effects: f.compartment.reconfigure(reader) })
  }
  return {
    destroy: () => prefersDark.removeEventListener('change', changed),
    themes: THEMES,
    theme,
    setTheme: (id) => {
      update({ ...current, theme: id })
      void showTheme()
    },
    fontSizeRange: fontSizes,
    fontSize,
    setFontSize: (size) => {
      fontSize.set(size)
      setText({ ...current, fontSize: size })
    },
    lineHeightRange: LINE_HEIGHT,
    lineHeight,
    setLineHeight: (height) => {
      lineHeight.set(height)
      setText({ ...current, lineHeight: height })
    },
    wrap,
    setWrap: (on) => {
      wrap.set(on)
      update({ ...current, wrap: on })
      editor.dispatch({ effects: wrapMode.reconfigure(lineWrapping(on)) })
    },
    vim: vimOn,
    setVim: (on) => {
      vimOn.set(on)
      void vim.set(on).then((ok) => {
        if (!ok) vimOn.set(vim.on)
      })
    },
    alwaysLoad: alwaysLoad.ids,
    forgetAlwaysLoad: (id) => alwaysLoad.forget(id),
  }
}
