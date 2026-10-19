import { describe, expect, it } from 'vitest'
import { allowOf, sandboxOf } from './define.ts'
import figma from './figma.ts'

const embed = (href: string) => figma.embed?.(new URL(href)) ?? null
const KEY = 'AbCdEfGhIjKlMnOpQrStUv'
const HOST = 'embed-host=pedit'

describe('figma', () => {
  it.each([
    [
      `https://www.figma.com/design/${KEY}/File?node-id=1-2&t=x`,
      `https://embed.figma.com/design/${KEY}?${HOST}&node-id=1-2`,
    ],
    [`https://figma.com/design/${KEY}`, `https://embed.figma.com/design/${KEY}?${HOST}`],
    // Legacy file links open in Figma Design.
    [`https://www.figma.com/file/${KEY}/Name`, `https://embed.figma.com/design/${KEY}?${HOST}`],
    [`https://www.figma.com/board/${KEY}/`, `https://embed.figma.com/board/${KEY}?${HOST}`],
    [`https://www.figma.com/slides/${KEY}`, `https://embed.figma.com/slides/${KEY}?${HOST}`],
    [`https://www.figma.com/deck/${KEY}`, `https://embed.figma.com/deck/${KEY}?${HOST}`],
    [
      `https://www.figma.com/proto/${KEY}/P?node-id=3:4&starting-point-node-id=5-6&scaling=x`,
      `https://embed.figma.com/proto/${KEY}?${HOST}&node-id=3:4&starting-point-node-id=5-6`,
    ],
    // A node id that is not one is left out.
    [
      `https://www.figma.com/design/${KEY}?node-id=1-2%26x%3Dy`,
      `https://embed.figma.com/design/${KEY}?${HOST}`,
    ],
    // The player's own URLs, with any embed-host replaced by pedit's.
    [
      `https://embed.figma.com/design/${KEY}?embed-host=other&node-id=1-2`,
      `https://embed.figma.com/design/${KEY}?${HOST}&node-id=1-2`,
    ],
  ])('embeds %s as %s', (href, src) => {
    expect(embed(href)).toBe(src)
    expect(embed(src)).toBe(src)
  })

  it.each([
    `https://www.figma.com/community/file/${KEY}`,
    `https://www.figma.com/design/${KEY.slice(1)}`,
    `https://www.figma.com/design/${KEY}/a/b`,
    `https://www.figma.com/design/${KEY}-x`,
    // The player host has no legacy /file/ path.
    `https://embed.figma.com/file/${KEY}`,
    `https://www.figma.com.evil.example/design/${KEY}`,
    `https://evilfigma.com/design/${KEY}`,
    `https://api.figma.com/design/${KEY}`,
    `https://www.figma.com@evil.example/design/${KEY}`,
    `https://user:pass@www.figma.com/design/${KEY}`,
    `https://www.figma.com:444/design/${KEY}`,
    `https://www.figma.com/design/${KEY}/..%2f..%2fx`,
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('is a 4:3 document that can sign in, without top navigation', () => {
    expect(figma.size).toEqual({ ratio: '4/3' })
    expect(sandboxOf(figma)).toBe('allow-scripts allow-same-origin allow-popups allow-forms')
    expect(allowOf(figma)).toBe('fullscreen; clipboard-write')
  })
})
