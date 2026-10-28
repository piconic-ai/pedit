import { expect, it } from 'vitest'
import { checkKeptCommentsState } from '../src/kept-comments-schema.ts'

it('rejects noncanonical Any values and unsafe integers', () => {
  const prefix = [1, 1, 1, 0, 0x28, 1, 8, 99, 111, 109, 109, 101, 110, 116, 115, 1, 107, 1]
  const cases: [number[], boolean][] = [
    [[125, 1], true],
    [[125, 0x81, 0], false],
    [[125, 0x40], false],
    [[125, 0xbf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f], true],
    [[125, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f], true],
    [[125, 0xc0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20], false],
    [[125, 0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20], false],
    [[119, 0x81, 0, 120], false],
    [[116, 0x81, 0, 1], false],
    [[117, 0x81, 0, 126], false],
    [[118, 1, 0x81, 0, 107, 126], false],
    [[116, 2, 1, 2], true],
  ]
  for (const [value, expected] of cases)
    expect(checkKeptCommentsState(Uint8Array.from([...prefix, ...value, 0]))).toBe(expected)
})
