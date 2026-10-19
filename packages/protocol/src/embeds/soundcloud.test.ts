import { describe, expect, it } from 'vitest'
import { allowOf, sandboxOf } from './define.ts'
import soundcloud from './soundcloud.ts'

const embed = (href: string) => soundcloud.embed?.(new URL(href)) ?? null
const player = (what: string) =>
  `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://api.soundcloud.com/${what}`)}&auto_play=false`

describe('soundcloud', () => {
  it.each([
    ['https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293', 'tracks/293'],
    [
      'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&auto_play=true&color=%23ff5500',
      'tracks/293',
    ],
    ['https://w.soundcloud.com/player?url=https://api.soundcloud.com/playlists/7', 'playlists/7'],
    // Share > Embed's URN form.
    [
      'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/soundcloud%3Atracks%3A293',
      'tracks/293',
    ],
    [
      'https://w.soundcloud.com/player/?url=https://api.soundcloud.com/playlists/soundcloud:playlists:7',
      'playlists/7',
    ],
  ])('embeds %s', (href, what) => {
    const src = player(what)
    expect(embed(href)).toBe(src)
    expect(embed(src)).toBe(src)
  })

  it.each([
    // A track page itself: the player needs the API's URL.
    'https://soundcloud.com/artist/track',
    'https://w.soundcloud.com/player/',
    'https://w.soundcloud.com/player/x?url=https://api.soundcloud.com/tracks/1',
    // What it plays must be a track or playlist of SoundCloud's API, over https.
    'https://w.soundcloud.com/player/?url=https%3A//evil.example/tracks/293',
    'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com.evil.example/tracks/293',
    'https://w.soundcloud.com/player/?url=http%3A//api.soundcloud.com/tracks/293',
    'https://w.soundcloud.com/player/?url=https%3A//user@api.soundcloud.com/tracks/293',
    'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com:444/tracks/293',
    'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/users/293',
    'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293/x',
    'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293%3Fx%3D1',
    'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293%23x',
    'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks%2F..%2Fusers/293',
    'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/soundcloud%3Aplaylists%3A7',
    'https://w.soundcloud.com/player/?url=not%20a%20url',
    // The player itself on another host or with user-info.
    'https://w.soundcloud.com.evil.example/player/?url=https%3A//api.soundcloud.com/tracks/293',
    'https://soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293',
    'https://user@w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293',
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('is a 166 pixel bar that never plays on its own', () => {
    expect(soundcloud.size).toEqual({ height: 166 })
    expect(sandboxOf(soundcloud)).toBe('allow-scripts allow-same-origin allow-popups')
    expect(allowOf(soundcloud)).toBe('autoplay')
  })
})
