import { describe, expect, it } from 'vitest'
import { allowOf, sandboxOf } from './define.ts'
import miro from './miro.ts'

const embed = (href: string) => miro.embed?.(new URL(href)) ?? null
const PLAYER = 'https://miro.com/app/live-embed/uXjVOabcdEF=/'

describe('miro', () => {
  it.each([
    ['https://miro.com/app/board/uXjVOabcdEF=/', PLAYER],
    ['https://miro.com/app/board/uXjVOabcdEF=/?share_link_id=1', PLAYER],
    ['https://miro.com/app/board/uXjVOabcdEF%3D', PLAYER],
    ['https://miro.com/app/live-embed/uXjVOabcdEF=/?moveToViewport=1', PLAYER],
    ['https://miro.com/app/board/o9J_abcdefgh/', 'https://miro.com/app/live-embed/o9J_abcdefgh/'],
  ])('embeds %s as %s', (href, src) => {
    expect(embed(href)).toBe(src)
    expect(embed(src)).toBe(src)
  })

  it.each([
    'https://miro.com/',
    'https://miro.com/app/dashboard/',
    'https://miro.com/app/board/short/',
    'https://miro.com/app/board/uXjVOabcdEF===/',
    'https://miro.com/app/board/uXjVOabcdEF=/x',
    'https://www.miro.com/app/board/uXjVOabcdEF=/',
    'https://miro.com.evil.example/app/board/uXjVOabcdEF=/',
    'https://user@miro.com/app/board/uXjVOabcdEF=/',
    'https://miro.com:8443/app/board/uXjVOabcdEF=/',
    'https://miro.com/app/board%2FuXjVOabcdEF=/',
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('is a 4:3 board that can sign in', () => {
    expect(miro.size).toEqual({ ratio: '4/3' })
    expect(sandboxOf(miro)).toBe('allow-scripts allow-same-origin allow-popups allow-forms')
    expect(allowOf(miro)).toBe('fullscreen')
  })
})
