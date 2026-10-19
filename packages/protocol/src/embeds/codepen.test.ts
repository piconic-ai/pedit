import { describe, expect, it } from 'vitest'
import codepen from './codepen.ts'
import { allowOf, sandboxOf } from './define.ts'

const embed = (href: string) => codepen.embed?.(new URL(href)) ?? null
const PLAYER = 'https://codepen.io/u/embed/AbC123'

describe('codepen', () => {
  it.each([
    ['https://codepen.io/u/pen/AbC123', `${PLAYER}?default-tab=result`],
    ['https://codepen.io/u/pen/AbC123/', `${PLAYER}?default-tab=result`],
    ['https://codepen.io/u/full/AbC123', `${PLAYER}?default-tab=result`],
    ['https://codepen.io/u/details/AbC123', `${PLAYER}?default-tab=result`],
    [
      'https://codepen.io/u/embed/AbC123?default-tab=html,result',
      `${PLAYER}?default-tab=html,result`,
    ],
    ['https://codepen.io/u/pen/AbC123?default-tab=css&editable=true', `${PLAYER}?default-tab=css`],
    ['https://codepen.io/u/pen/AbC123?default-tab=evil', `${PLAYER}?default-tab=result`],
    ['https://codepen.io/team-x_1/pen/z', 'https://codepen.io/team-x_1/embed/z?default-tab=result'],
  ])('embeds %s as %s', (href, src) => {
    expect(embed(href)).toBe(src)
    expect(embed(src)).toBe(src)
  })

  it.each([
    // Its frames are the whole origin, so embed() alone names the players.
    'https://codepen.io/',
    'https://codepen.io/login',
    'https://codepen.io/u',
    'https://codepen.io/u/pen/AbC123/x',
    'https://codepen.io/u/pen/Ab-C',
    'https://codepen.io/team/u/pen/AbC123',
    'https://codepen.io.evil.example/u/pen/AbC123',
    'https://www.codepen.io/u/pen/AbC123',
    'https://cdpn.io/u/pen/AbC123',
    'https://user@codepen.io/u/pen/AbC123',
    'https://codepen.io@evil.example/u/pen/AbC123',
    'https://codepen.io:8080/u/pen/AbC123',
    'https://codepen.io/u%2fpen/AbC123',
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('is a 4:3 document with forms and dialogs', () => {
    expect(codepen.size).toEqual({ ratio: '4/3' })
    expect(sandboxOf(codepen)).toBe(
      'allow-scripts allow-same-origin allow-popups allow-forms allow-modals',
    )
    expect(allowOf(codepen)).toBe('fullscreen; clipboard-write')
  })
})
