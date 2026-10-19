import { describe, expect, it } from 'vitest'
import { allowOf, sandboxOf } from './define.ts'
import spotify from './spotify.ts'

const embed = (href: string) => spotify.embed?.(new URL(href)) ?? null
const ID = '4uLU6hMCjMI75M1A2tKUQC'

describe('spotify', () => {
  it.each(['track', 'album', 'playlist', 'artist', 'episode', 'show'])('embeds a %s', (type) => {
    const src = `https://open.spotify.com/embed/${type}/${ID}`
    expect(embed(`https://open.spotify.com/${type}/${ID}?si=x`)).toBe(src)
    expect(embed(src)).toBe(src)
  })

  it.each([
    `https://open.spotify.com/intl-de/track/${ID}`,
    `https://open.spotify.com/intl-pt-BR/track/${ID}/`,
    `https://open.spotify.com/embed/track/${ID}?utm_source=generator`,
  ])('embeds %s without its locale or query', (href) => {
    expect(embed(href)).toBe(`https://open.spotify.com/embed/track/${ID}`)
  })

  it.each([
    'https://open.spotify.com/',
    `https://open.spotify.com/user/${ID}`,
    `https://open.spotify.com/track/${ID.slice(1)}`,
    `https://open.spotify.com/track/${ID}/x`,
    `https://open.spotify.com/intl-/track/${ID}`,
    `https://open.spotify.com/embed/intl-de/track/${ID}`,
    `https://spotify.com/track/${ID}`,
    `https://open.spotify.com.evil.example/track/${ID}`,
    `https://user@open.spotify.com/track/${ID}`,
    `https://open.spotify.com:8443/track/${ID}`,
    `https://open.spotify.com/track%2F${ID}`,
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('is a 152 pixel bar that can play whole tracks', () => {
    expect(spotify.size).toEqual({ height: 152 })
    expect(sandboxOf(spotify)).toBe(
      'allow-scripts allow-same-origin allow-popups allow-presentation',
    )
    expect(allowOf(spotify)).toBe(
      'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
    )
  })
})
