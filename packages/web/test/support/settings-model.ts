import type { Range, SettingsModel } from '../../src/settings.ts'
import { Store } from '../../src/store.ts'
import { THEMES } from '../../src/themes.ts'

/** A settings model backed by plain stores, recording what each control asked for. */
export function fakeSettings(
  options: { theme?: string; vimFails?: boolean; alwaysLoad?: readonly string[] } = {},
) {
  const calls: [string, unknown][] = []
  const theme = new Store(options.theme ?? 'github-light')
  const fontSize = new Store(15)
  const lineHeight = new Store(1.6)
  const wrap = new Store(true)
  const vim = new Store(false)
  const alwaysLoad = new Store<readonly string[]>(options.alwaysLoad ?? [])
  const fontSizeRange: Range = { min: 12, max: 24, step: 1 }
  const lineHeightRange: Range = { min: 1.2, max: 2, step: 0.1 }
  const model: SettingsModel = {
    themes: THEMES,
    theme,
    setTheme: (id) => {
      calls.push(['theme', id])
      theme.set(id)
    },
    fontSizeRange,
    fontSize,
    setFontSize: (v) => {
      calls.push(['fontSize', v])
      fontSize.set(v)
    },
    lineHeightRange,
    lineHeight,
    setLineHeight: (v) => {
      calls.push(['lineHeight', v])
      lineHeight.set(v)
    },
    wrap,
    setWrap: (v) => {
      calls.push(['wrap', v])
      wrap.set(v)
    },
    vim,
    setVim: (v) => {
      calls.push(['vim', v])
      vim.set(v)
      // As main.ts does once the Vim mode fails to load: put the control back.
      if (options.vimFails) void Promise.resolve().then(() => vim.set(false))
    },
    alwaysLoad,
    forgetAlwaysLoad: (id) => {
      calls.push(['forgetAlwaysLoad', id])
      alwaysLoad.set(alwaysLoad.get().filter((i) => i !== id))
    },
  }
  return { model, calls, stores: { theme, fontSize, lineHeight, wrap, vim, alwaysLoad } }
}
