import { describe, expect, it } from 'vitest'
import generated from '../../testdata/kept-schema-generated-mutations.json'
import vectors from '../../testdata/kept-schema-mutations.json'
import { checkKeptCommentsState } from '../src/kept-comments-schema.ts'
import { checkKeptTextState } from '../src/kept-text-schema.ts'

describe('Go and browser checkpoint schema mutation vectors', () => {
  for (const vector of [...vectors, ...generated]) {
    it(vector.name, () => {
      const bytes = Uint8Array.from(vector.hex.match(/../g) ?? [], (v) => Number.parseInt(v, 16))
      expect(
        vector.kind === 'text' ? checkKeptTextState(bytes) : checkKeptCommentsState(bytes),
      ).toBe(vector.valid)
    })
  }
})
