import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: plain JS helper without type declarations
import { thirdPartyLicenses } from '../../scripts/third-party-licenses.mjs'

const moduleIn = (pkg: string) =>
  join(realpathSync(resolve(import.meta.dirname, '../node_modules', pkg)), 'index.js')

describe('thirdPartyLicenses', () => {
  it('lists each bundled package with its own license file', () => {
    const text: string = thirdPartyLicenses([moduleIn('@codemirror/theme-one-dark')], 'Intro.')
    expect(text).toMatch(
      /^Intro\.\n\n@codemirror\/theme-one-dark@[\d.]+ \(MIT\)\n-+\n\nMIT License/,
    )
  })

  it('uses the vendored text for packages that do not ship one', () => {
    const text: string = thirdPartyLicenses([moduleIn('@uiw/codemirror-theme-github')], 'Intro.')
    expect(text).toContain('@uiw/codemirror-theme-github@')
    expect(text).toContain('Copyright (c) 2021 uiw')
  })

  it('lists what a package inlines in its own build, but not type declarations', () => {
    const text: string = thirdPartyLicenses([moduleIn('@barefootjs/xyflow')], 'Intro.')
    expect(text).toContain('@barefootjs/xyflow@')
    expect(text).toMatch(/@xyflow\/system@[\d.]+ \(MIT\)/)
    expect(text).toMatch(/d3-zoom@[\d.]+ \(ISC\)/)
    expect(text).not.toContain('@types/')
    // Kept external by its build, so listed only when bundled on its own.
    expect(text).not.toContain('@barefootjs/client@')
  })

  it('lists what was copied into the source, with the text it came under', () => {
    const text: string = thirdPartyLicenses([], 'Intro.', [
      { header: 'Octicons mark-github (MIT), in src/info.ts', file: 'primer-octicons.txt' },
    ])
    expect(text).toMatch(
      /^Intro\.\n\nOcticons mark-github \(MIT\), in src\/info\.ts\n-+\n\nMIT License/,
    )
    expect(text).toContain('Copyright (c) 2026 GitHub Inc.')
  })

  it('refuses packages with no license text at all', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'pedit-licenses-')), 'node_modules', 'nolicense')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'nolicense', version: '1.0.0' }),
    )
    expect(() => thirdPartyLicenses([join(dir, 'index.js')], '')).toThrow(/nolicense@1.0.0/)
  })
})
