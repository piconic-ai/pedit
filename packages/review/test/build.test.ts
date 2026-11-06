import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')

/**
 * URLs that appear in the bundle without being requested: XML namespaces and
 * links in comments. Exact, so a new one is looked at before it is allowed.
 */
const ALLOWED_URLS = new Set([
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/2000/svg',
  'https://github.com/piconic-ai/barefootjs/issues/2733',
  'https://github.com/yjs/yjs/issues/438',
])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? files(path).map((f) => join(name, f)) : [name]
  })
}

describe('the built element', () => {
  let bundle: string
  beforeAll(() => {
    execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: 'pipe' })
    bundle = readFileSync(join(dist, 'pedit-review.js'), 'utf8')
  }, 120_000)

  it('is one JavaScript file, next to reviewCSP, its types and the licenses', () => {
    expect(files(dist).sort()).toEqual([
      'THIRD_PARTY_LICENSES.txt',
      'csp.d.ts',
      'csp.js',
      'pedit-review.js',
      'relay.d.ts',
    ])
  })

  it('starts with a banner naming the package version', () => {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    expect(bundle.split('\n')[0]).toBe(`/*! @pedit/review ${version} */`)
    expect(bundle.match(/@pedit\/review \d/g)).toHaveLength(1)
  })

  it('imports nothing and loads no code, worker or font', () => {
    expect(bundle).not.toMatch(/^\s*import[\s{*"']/m)
    expect(bundle).not.toMatch(/\bimport\s*\(/)
    expect(bundle).not.toContain('new Worker')
    expect(bundle).not.toContain('@font-face')
  })

  it('names no URL that it could request, and never touches localStorage', () => {
    const urls = [...bundle.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)\\<>]*/g)].map((m) => m[0])
    expect(urls.filter((u) => !ALLOWED_URLS.has(u))).toEqual([])
    expect(bundle).not.toContain('localStorage')
  })

  it('builds no URL out of a scheme and a host', () => {
    // A bare "https://" or "wss://" literal is the start of a URL made at run time.
    expect(bundle).not.toMatch(/["'`](?:https?|wss?):\/\/["'`]/)
    expect(bundle).not.toMatch(/["'`](?:https?|wss?):["'`]\s*\+/)
  })

  it('keeps reviewCSP out of the element', () => {
    expect(bundle).not.toContain('frame-ancestors')
  })
})
