/**
 * Guards the edge of `src/core/`.
 *
 * The core is shared by the relay's editor and a `<pedit-review>` web
 * component that runs inside a shadow root on another app's page (see
 * docs/design/embedding.md, "Review core"). There it must not reach for the
 * page it sits in: another app's URL, storage, title or `#app` element. So a
 * core file may only import npm packages, `@pedit/protocol` and other core
 * files, and must take everything from the page as an argument.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const core = resolve(import.meta.dirname, '../src/core')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return /\.tsx?$/.test(e.name) ? [path] : []
  })
}

/** The code without comments, so prose does not trip the rules. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const FORBIDDEN: [string, RegExp][] = [
  ['location', /\blocation\b/],
  ['localStorage', /\blocalStorage\b/],
  ['sessionStorage', /\bsessionStorage\b/],
  ['document.title', /\bdocument\.title\b/],
  ['window.', /\bwindow\./],
  ['#app', /#app\b/],
]

const files = sources(core)

describe('src/core boundary', () => {
  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    const name = relative(core, file).split(sep).join('/')
    const text = code(readFileSync(file, 'utf8'))

    it(`${name} imports nothing outside core`, () => {
      const outside = [...text.matchAll(/(?:from\s+|import\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)]
        .map((m) => m[1] as string)
        .filter((spec) => {
          const rel = relative(core, resolve(dirname(file), spec))
          return rel.startsWith('..')
        })
      expect(outside).toEqual([])
    })

    it(`${name} does not read the page it runs in`, () => {
      const used = FORBIDDEN.filter(([, re]) => re.test(text)).map(([label]) => label)
      expect(used).toEqual([])
    })
  }
})
