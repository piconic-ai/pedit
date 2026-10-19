import { describe, expect, it } from 'vitest'
// Also read by the Go side (internal/protocol/path_test.go), so both agree.
import vectors from '../../testdata/path-vectors.json'
import { checkPath, MAX_COMPONENT_BYTES, MAX_PATH_BYTES } from '../src/index.ts'

describe('checkPath', () => {
  it('accepts the shared vectors', () => {
    expect(vectors.accepted.length).toBeGreaterThan(0)
    for (const path of vectors.accepted) expect([path, checkPath(path)]).toEqual([path, null])
  })

  it('refuses the shared vectors, for the same reasons as Go', () => {
    expect(vectors.refused.length).toBeGreaterThan(0)
    for (const c of vectors.refused)
      expect([c.path, checkPath(c.path)]).toEqual([c.path, c.problem])
  })

  it('bounds lengths in bytes', () => {
    const component = 'a'.repeat(MAX_COMPONENT_BYTES)
    expect(checkPath(component)).toBeNull()
    expect(checkPath(`${component}a`)).toBe('component-too-long')
    // 128 "é" are 256 bytes.
    expect(checkPath('é'.repeat(128))).toBe('component-too-long')
    const long = `${'a'.repeat(200)}/`.repeat(5) + 'a'.repeat(MAX_PATH_BYTES - 5 * 201)
    expect(checkPath(long)).toBeNull()
    expect(checkPath(`${long}a`)).toBe('too-long')
  })

  it('refuses lone surrogates, which have no UTF-8', () => {
    expect(checkPath('a\ud800b.md')).toBe('encoding')
    expect(checkPath('docs/\udc00.md')).toBe('encoding')
    expect(checkPath('😀.md')).toBeNull()
  })
})
