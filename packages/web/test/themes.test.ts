// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Compartment, EditorSelection, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { afterEach, describe, expect, it } from 'vitest'
import { yCollab } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { composite, contrast } from '../src/contrast.ts'
import { PALETTE_VARS, type PagePalette } from '../src/palette.ts'
import { COLORS, selectionTint } from '../src/room.ts'
import {
  CARET_HALO,
  DEFAULT_THEME,
  fallbackTheme,
  loadTheme,
  readerTheme,
  THEMES,
  ThemeSwitcher,
  themeInfo,
  themeOrDefault,
} from '../src/themes.ts'

const views: EditorView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
})

function mount(extensions: Extension) {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    extensions,
  })
  views.push(view)
  return view
}

/** `rgb(1, 2, 3)` as jsdom computes it, to `#010203`. */
function hex(rgb: string): string {
  const parts = rgb.match(/\d+/g)?.slice(0, 3) ?? []
  return `#${parts.map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`
}

describe('theme registry', () => {
  it('has unique ids, a mix of light and dark, and the defaults', () => {
    const ids = THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    const light = THEMES.filter((t) => t.scheme === 'light').length
    const dark = THEMES.filter((t) => t.scheme === 'dark').length
    expect(light).toBeGreaterThanOrEqual(5)
    expect(dark).toBeGreaterThanOrEqual(5)
    expect(themeInfo(DEFAULT_THEME.light)?.scheme).toBe('light')
    expect(themeInfo(DEFAULT_THEME.dark)?.scheme).toBe('dark')
  })

  it.each(THEMES.map((t) => [t.id, t] as const))(
    '%s loads with its declared scheme and colours',
    async (_, theme) => {
      const view = mount(await theme.load())
      expect(view.state.facet(EditorView.darkTheme)).toBe(theme.scheme === 'dark')
      const style = getComputedStyle(view.dom)
      expect(hex(style.backgroundColor)).toBe(theme.bg)
      expect(hex(style.color)).toBe(theme.fg)
    },
  )
})

describe('default themes', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/style.css'), 'utf8')
  // `--panel: light-dark(#ffffff, #0d1117);` and so on.
  const fromCss = (name: string) => {
    const hex = '(#[0-9a-f]{6}(?:[0-9a-f]{2})?)'
    const m = new RegExp(`${name}:\\s*light-dark\\(${hex},\\s*${hex}\\)`).exec(css)
    if (!m) throw new Error(`${name} not found in style.css`)
    return { light: m[1], dark: m[2] }
  }
  const light = themeOrDefault(null, 'light').page
  const dark = themeOrDefault(null, 'dark').page

  it.each(Object.entries(PALETTE_VARS))('paint style.css before any script for %s', (key, name) => {
    const k = key as keyof PagePalette
    expect(fromCss(name)).toEqual({ light: light[k], dark: dark[k] })
  })

  it('are bundled, so they show at once and serve as the fallback', async () => {
    for (const scheme of ['light', 'dark'] as const) {
      const { id, extension } = fallbackTheme(DEFAULT_THEME[scheme])
      expect(id).toBe(DEFAULT_THEME[scheme])
      expect(await loadTheme(id)).toBe(extension)
    }
  })
})

describe('page palettes', () => {
  it.each(THEMES.map((t) => [t.id, t] as const))(
    'match the editor and keep the page readable on %s',
    (_, theme) => {
      const p = theme.page
      expect(p.panel).toBe(theme.bg)
      // Text, secondary text, links, and the panel colour on accent buttons.
      for (const color of [p.ink, p.muted, p.accent]) {
        expect(contrast(color, p.panel), color).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(p.ink, p.bg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.ink, composite(p.codeBg, p.panel))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(p.warnInk, p.warnBg)).toBeGreaterThanOrEqual(4.5)
      // Borders and the panels stand apart from what surrounds them.
      expect(contrast(p.line, p.panel)).toBeGreaterThan(1.1)
      expect(p.bg).not.toBe(p.panel)
    },
  )

  it('looks up themes and falls back to the default of the scheme for unknown ids', () => {
    expect(themeOrDefault('dracula', 'light').id).toBe('dracula')
    expect(themeOrDefault('nord', 'dark').id).toBe('github-dark')
    expect(themeOrDefault(null, 'light').id).toBe('github-light')
  })
})

describe('remote cursors and selections', () => {
  it('prints caret labels (white text) readably on every participant colour', () => {
    for (const color of COLORS) {
      expect(contrast('#ffffff', color), color).toBeGreaterThanOrEqual(4.5)
    }
  })

  // WCAG 1.4.11: carets are UI components and need 3:1 against what is around them.
  it.each(THEMES.map((t) => [t.id, t] as const))(
    'are visible and keep text readable on %s',
    (_, theme) => {
      for (const color of COLORS) {
        if (theme.scheme === 'dark') {
          // The halo sits between the caret and the background.
          expect(contrast(color, CARET_HALO), color).toBeGreaterThanOrEqual(3)
          expect(contrast(CARET_HALO, theme.bg)).toBeGreaterThanOrEqual(3)
        } else {
          expect(contrast(color, theme.bg), color).toBeGreaterThanOrEqual(3)
        }

        const tinted = composite(selectionTint(color), theme.bg)
        // Some themes ship text below 4.5:1 themselves; the tint may not push it under 3:1.
        expect(contrast(theme.fg, tinted), `text over ${color}`).toBeGreaterThanOrEqual(3)
        // Still distinguishable from the background.
        expect(contrast(tinted, theme.bg), `tint of ${color}`).toBeGreaterThanOrEqual(1.1)
      }
    },
  )

  it.each(['light', 'dark'] as const)(
    'draws the caret halo only on %s themes that need it',
    (scheme) => {
      const view = mount([fallbackTheme(DEFAULT_THEME[scheme]).extension, readerTheme()])
      const caret = view.contentDOM.appendChild(document.createElement('span'))
      caret.className = 'cm-ySelectionCaret'
      const shadow = getComputedStyle(caret).boxShadow
      if (scheme === 'dark') expect(shadow).toContain('#ffffff')
      // Browsers and jsdom >= 30.1.3 report no shadow as 'none'; older jsdom gives ''.
      else expect(['', 'none']).toContain(shadow)
    },
  )
})

describe('readerTheme', () => {
  it('alternates between two pre-built extensions, never returning the same one twice in a row', () => {
    // CodeMirror only remeasures line heights (and so the gutter) when a
    // reconfigured theme counts as a change, so consecutive calls must
    // differ; but minting a fresh EditorView.theme() every call would leak
    // a StyleModule (and its mounted CSS rules) on every settings change,
    // since style-mod never releases one once mounted.
    const calls = [readerTheme(), readerTheme(), readerTheme(), readerTheme()]
    expect(calls[0]).not.toBe(calls[1])
    expect(calls[1]).not.toBe(calls[2])
    expect(calls[2]).not.toBe(calls[3])
    expect(new Set(calls).size).toBe(2)
  })

  it('reconfiguring through a Compartment changes themeClasses every time, keeping the document and selection', () => {
    // themeClasses is what EditorView.update actually compares (it embeds
    // the theme facet) to decide whether to remeasure; asserting on it,
    // rather than on our own wrapper reference, would catch a "fresh array
    // around one cached theme" regression that still looks different by
    // `.not.toBe` but never changes what CodeMirror sees.
    const doc = new Y.Doc()
    const text = doc.getText('content')
    const font = new Compartment()
    const view = mount([basicSetup, font.of(readerTheme()), yCollab(text, new Awareness(doc))])
    doc.transact(() => text.insert(0, 'shared text'), 'remote')
    view.dispatch({ selection: EditorSelection.single(2, 6) })

    let previous = view.themeClasses
    for (let i = 0; i < 5; i++) {
      view.dispatch({ effects: font.reconfigure(readerTheme()) })
      expect(view.themeClasses).not.toBe(previous)
      previous = view.themeClasses
    }

    expect(view.state.doc.toString()).toBe('shared text')
    expect(view.state.selection.main).toMatchObject({ from: 2, to: 6 })
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** A theme extension that tags the editor, so tests can tell which one is active. */
function marker(name: string): Extension {
  return EditorView.editorAttributes.of({ 'data-theme': name })
}

function setup() {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const theme = new Compartment()
  const view = mount([
    basicSetup,
    theme.of(marker('start')),
    readerTheme(),
    yCollab(text, new Awareness(doc)),
  ])
  doc.transact(() => text.insert(0, 'shared text'), 'remote')
  return { doc, text, theme, view }
}

describe('ThemeSwitcher', () => {
  it('reconfigures the real themes keeping the document, selection and Yjs binding', async () => {
    const { doc, text, theme, view } = setup()
    view.dispatch({ selection: EditorSelection.single(2, 6) })
    const switcher = new ThemeSwitcher(view, theme, 'github-light')

    for (const id of ['dracula', 'solarized-light', 'github-dark']) {
      expect(await switcher.set(id)).toBe(true)
      expect(switcher.id).toBe(id)
      expect(view.state.facet(EditorView.darkTheme)).toBe(themeInfo(id)?.scheme === 'dark')
    }
    expect(view.state.doc.toString()).toBe('shared text')
    expect(view.state.selection.main).toMatchObject({ from: 2, to: 6 })

    // A remote edit still arrives through the same binding.
    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc))
    remote.getText('content').insert(0, '> ')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)), 'remote')
    expect(view.state.doc.toString()).toBe('> shared text')
    expect(text.toString()).toBe('> shared text')
  })

  it('ends on the latest choice when an earlier one loads slowly', async () => {
    const { theme, view } = setup()
    const slow = deferred<Extension>()
    const switcher = new ThemeSwitcher(view, theme, 'github-light', (id) =>
      id === 'dracula' ? slow.promise : Promise.resolve(marker(id)),
    )

    const first = switcher.set('dracula')
    await switcher.set('github-light')
    slow.resolve(marker('dracula'))
    await first
    expect(switcher.id).toBe('github-light')
    expect(view.dom.dataset.theme).toBe('github-light')
  })

  it('falls back to the default theme of the same scheme when a theme cannot load', async () => {
    const { theme, view } = setup()
    const switcher = new ThemeSwitcher(view, theme, 'github-light', () =>
      Promise.reject(new Error('offline')),
    )

    expect(await switcher.set('dracula')).toBe(false)
    expect(switcher.id).toBe('github-dark')
    expect(view.state.facet(EditorView.darkTheme)).toBe(true)
    expect(view.dom.dataset.theme).toBeUndefined()
  })
})
