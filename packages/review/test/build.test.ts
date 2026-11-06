import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const dist = join(root, 'dist')

/** URLs that appear in the bundle without being requested: XML namespaces and the like. */
const ALLOWED_URLS = [
  /^https?:\/\/www\.w3\.org\//,
  /^https?:\/\/(?:github\.com|reactjs\.org|react\.dev|developer\.mozilla\.org|bugzilla\.mozilla\.org|crbug\.com|bugs\.chromium\.org|bugs\.webkit\.org)\//,
]

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

  it('is one JavaScript file, next to reviewCSP and the licenses', () => {
    expect(files(dist).sort()).toEqual([
      'THIRD_PARTY_LICENSES.txt',
      'csp.d.ts',
      'csp.js',
      'pedit-review.js',
    ])
  })

  it('imports nothing and loads no code, worker or font', () => {
    expect(bundle).not.toMatch(/^\s*import[\s{*"']/m)
    expect(bundle).not.toMatch(/\bimport\s*\(/)
    expect(bundle).not.toContain('new Worker')
    expect(bundle).not.toContain('@font-face')
  })

  it('names no URL that it could request, and never touches localStorage', () => {
    const urls = [...bundle.matchAll(/https?:\/\/[^\s"'`)\\<>]+/g)].map((m) => m[0])
    const stray = urls.filter((u) => !ALLOWED_URLS.some((ok) => ok.test(u)))
    expect(stray).toEqual([])
    expect(bundle).not.toContain('localStorage')
  })

  it('keeps reviewCSP out of the element', () => {
    expect(bundle).not.toContain('frame-ancestors')
  })
})
