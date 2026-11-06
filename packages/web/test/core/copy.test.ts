// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { copyText } from '../../src/core/copy.ts'

describe('copyText', () => {
  it('writes the text to the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    expect(await copyText('hello', { writeText })).toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('reports failure when the clipboard refuses or is missing', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    expect(await copyText('hello', { writeText })).toBe(false)
    expect(await copyText('hello', undefined)).toBe(false)
  })
})
