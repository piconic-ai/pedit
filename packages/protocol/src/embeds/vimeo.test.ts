import { describe, expect, it } from 'vitest'
import { allowOf, sandboxOf } from './define.ts'
import vimeo from './vimeo.ts'

const embed = (href: string) => vimeo.embed?.(new URL(href)) ?? null
const PLAYER = 'https://player.vimeo.com/video/76979871'

describe('vimeo', () => {
  it.each([
    ['https://vimeo.com/76979871', PLAYER],
    ['https://www.vimeo.com/76979871/', PLAYER],
    ['http://vimeo.com/76979871', PLAYER],
    // Unlisted videos keep their hash, from the path or from ?h=.
    ['https://vimeo.com/76979871/abc123', `${PLAYER}?h=abc123`],
    ['https://vimeo.com/76979871?h=abc123', `${PLAYER}?h=abc123`],
    [`${PLAYER}?h=abc123`, `${PLAYER}?h=abc123`],
    [`${PLAYER}?h=abc123&autoplay=1`, `${PLAYER}?h=abc123`],
    // A hash that is not hex is dropped.
    [`${PLAYER}?h=xyz`, PLAYER],
    // User-info is not carried over: the player is rebuilt from the id.
    ['https://user@vimeo.com/76979871', PLAYER],
  ])('embeds %s as %s', (href, src) => {
    expect(embed(href)).toBe(src)
    // The player URL it builds is one it would build again.
    expect(embed(src)).toBe(src)
  })

  it.each([
    'https://vimeo.com/',
    'https://vimeo.com/channels/staffpicks',
    'https://vimeo.com/76979871/abc123/extra',
    'https://player.vimeo.com/video/abc/xyz',
    'https://player.vimeo.com/76979871',
    // Look-alike hosts and user-info that hides the real host.
    'https://vimeo.com.evil.example/76979871',
    'https://evil-vimeo.com/76979871',
    'https://player.vimeo.com.evil.example/video/76979871',
    'https://vimeo.com@evil.example/76979871',
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('is a 16:9 player with presentation and media features', () => {
    expect(vimeo.size).toEqual({ ratio: '16/9' })
    expect(sandboxOf(vimeo)).toBe('allow-scripts allow-same-origin allow-popups allow-presentation')
    expect(allowOf(vimeo)).toBe('fullscreen; picture-in-picture; encrypted-media')
  })
})
