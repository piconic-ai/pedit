/**
 * Guards the CSS of `src/core/`.
 *
 * A `<pedit-review>` web component puts the core's CSS in a shadow root and is
 * themed only through custom properties (docs/design/embedding.md). So the core
 * CSS must not style the page around it (`:root`, `html`, `body`, `#app`, `*`)
 * or give custom properties their defaults, and every class the core's
 * components use has to be styled from the core, not left to the page.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = resolve(import.meta.dirname, '../src')
const partsDir = join(src, 'core/css')
const parts = readdirSync(partsDir)
  .filter((f) => f.endsWith('.css'))
  .sort()

/** The CSS without comments and without the contents of strings. */
function strip(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"[^"]*"|'[^']*'/g, '""')
}

const coreCss = strip(parts.map((f) => readFileSync(join(partsDir, f), 'utf8')).join('\n'))

/** Each selector list in the CSS (what comes before a `{`), split on commas outside brackets. */
function selectors(css: string): string[] {
  return [...css.matchAll(/([^{}]+)\{/g)]
    .map((m) => (m[1] ?? '').trim())
    .filter((s) => !s.startsWith('@'))
    .flatMap((s) => s.split(/,(?![^([]*[)\]])/).map((x) => x.trim()))
}

/** Class tokens the core's components write as plain strings. */
function componentClasses(): string[] {
  const dir = join(src, 'core/components')
  const tokens = new Set<string>()
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
    const text = readFileSync(join(dir, f), 'utf8')
    for (const m of text.matchAll(/\bclass(?:Name)?="([^"]*)"/g)) {
      for (const t of (m[1] ?? '').split(/\s+/).filter(Boolean)) tokens.add(t)
    }
  }
  return [...tokens].sort()
}

/** Classes that need no core rule on purpose. */
const PAGE_STYLED = new Set<string>([
  // A hook only: it marks the banner as the notice (tests, mounts) and carries no rule.
  'notice',
])

describe('core css', () => {
  it('has parts, and core.css lists them all in the order style.css imports them', () => {
    expect(parts.length).toBeGreaterThan(0)
    const list = (file: string, prefix: string) =>
      [...readFileSync(join(src, file), 'utf8').matchAll(/@import ["']\.\/([^"']+)["'];/g)]
        .map((m) => m[1] as string)
        .filter((p) => p.startsWith(prefix))
    const fromCore = list('core/core.css', '').map((p) => p.replace(/^css\//, ''))
    const fromPage = list('style.css', 'core/css/').map((p) => p.replace(/^core\/css\//, ''))
    expect(fromCore).toEqual(fromPage)
    expect([...fromCore].sort()).toEqual(parts)
  })

  it('does not style the page around it', () => {
    const forbidden = /^(:root|html|body|#app|\*)(?![\w-])/
    const bad = selectors(coreCss).filter((s) => forbidden.test(s))
    expect(bad).toEqual([])
  })

  it('sets no custom property, so the page or host gives the defaults', () => {
    expect(coreCss.match(/(^|[;{\s])--[\w-]+\s*:/g) ?? []).toEqual([])
  })

  it('styles every class its components use', () => {
    const missing = componentClasses().filter(
      (t) => !PAGE_STYLED.has(t) && !new RegExp(`\\.${t}(?![\\w-])`).test(coreCss),
    )
    expect(missing).toEqual([])
  })
})
