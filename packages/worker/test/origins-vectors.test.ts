import { describe, expect, it } from 'vitest'
// Read by the Go side too (internal/protocol/origins_test.go), so both accept the same lists.
import vectors from '../../testdata/origin-vectors.json'
import { parseOrigins } from '../src/origins.ts'

describe('parseOrigins', () => {
  for (const v of vectors as { origins: string[]; ok: boolean; result?: string[] }[]) {
    it(`${v.ok ? 'accepts' : 'refuses'} ${JSON.stringify(v.origins)}`, () => {
      // The header carries the list comma-separated; an empty list sends no header.
      const got = parseOrigins(v.origins.length === 0 ? null : v.origins.join(','))
      if (!v.ok) return expect(got).toBeUndefined()
      expect(got).toEqual(v.result ?? v.origins)
    })
  }
})
