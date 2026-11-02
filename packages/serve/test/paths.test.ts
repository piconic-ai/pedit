import { describe, expect, it } from 'vitest'
import { withFallback, withFallbackAsync } from '../src/paths.ts'

const fail = (code: string) => (): never => {
  throw Object.assign(new Error(code), { code })
}

describe('realpath fallback', () => {
  it('uses the JS realpath when the native call is unsupported on the volume', async () => {
    expect(withFallback(fail('UNKNOWN'), (p) => `js:${p}`)('x')).toBe('js:x')
    const native = async (_p: string): Promise<string> => fail('EINVAL')()
    expect(await withFallbackAsync(native, async (p) => `js:${p}`)('x')).toBe('js:x')
  })

  it('does not hide an error about the path itself', async () => {
    for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP']) {
      expect(() => withFallback(fail(code), () => 'js')('x')).toThrow(code)
      const native = async (_p: string): Promise<string> => fail(code)()
      await expect(withFallbackAsync(native, async () => 'js')('x')).rejects.toThrow(code)
    }
  })
})
