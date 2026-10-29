// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import cases from '../../testdata/kept-reference-cases.json'
import type { ImageResolver } from '../src/attachments.ts'
import { render } from '../src/preview.ts'

describe('retained attachment reference cases', () => {
  for (const item of cases) {
    it(item.name, () => {
      const lookups: string[] = []
      const resolver: ImageResolver = {
        lookup: (src) => {
          lookups.push(src)
          return null
        },
        owns: () => false,
      }
      for (const breaks of [false, true]) {
        lookups.length = 0
        render(item.source, resolver, [], { breaks })
        expect(lookups).toEqual(item.lookups)
      }
    })
  }
})
