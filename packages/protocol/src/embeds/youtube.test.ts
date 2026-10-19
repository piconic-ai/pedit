import { describe, expect, it } from 'vitest'
import { allowOf, sandboxOf } from './define.ts'
import youtube from './youtube.ts'

const embed = (href: string) => youtube.embed?.(new URL(href)) ?? null
const PLAYER = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'

describe('youtube', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', PLAYER],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&list=x', PLAYER],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', PLAYER],
    ['http://www.youtube.com/watch?v=dQw4w9WgXcQ', PLAYER],
    ['https://youtu.be/dQw4w9WgXcQ', PLAYER],
    ['https://youtu.be/dQw4w9WgXcQ?t=90', `${PLAYER}?start=90`],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s', `${PLAYER}?start=90`],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s', `${PLAYER}?start=3723`],
    // The largest compound start that still reads back as itself.
    ['https://youtu.be/dQw4w9WgXcQ?t=277h46m39s', `${PLAYER}?start=999999`],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', PLAYER],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', PLAYER],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ?start=5', `${PLAYER}?start=5`],
    [`${PLAYER}?start=999999`, `${PLAYER}?start=999999`],
    // User-info is not carried over: the player is rebuilt from the id.
    ['https://user@www.youtube.com/watch?v=dQw4w9WgXcQ', PLAYER],
  ])('embeds %s as %s', (href, src) => {
    expect(embed(href)).toBe(src)
    // The player URL it builds is one it would build again.
    expect(embed(src)).toBe(src)
  })

  it.each([
    // Too long to write as a plain integer: `1e+23` would read back as no start.
    ['https://youtu.be/dQw4w9WgXcQ?t=99999999999999999999999', PLAYER],
    ['https://youtu.be/dQw4w9WgXcQ?t=1234567', PLAYER],
    ['https://youtu.be/dQw4w9WgXcQ?t=99999999999h', PLAYER],
    // A compound start over six digits: the start goes, the player stays.
    ['https://youtu.be/dQw4w9WgXcQ?t=278h', PLAYER],
    ['https://youtu.be/dQw4w9WgXcQ?t=277h46m40s', PLAYER],
    ['https://youtu.be/dQw4w9WgXcQ?t=1e3', PLAYER],
    ['https://youtu.be/dQw4w9WgXcQ?t=-5', PLAYER],
  ])('drops a start it cannot read from %s', (href, src) => {
    expect(embed(href)).toBe(src)
    expect(embed(src)).toBe(src)
  })

  it.each([
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ"onload="x',
    'https://www.youtube-nocookie.com/embed/',
    'https://www.youtube.com/channel/dQw4w9WgXcQ',
    // Look-alike hosts and user-info that hides the real host.
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://evil-youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be.evil.example/dQw4w9WgXcQ',
    'https://www.youtube.com@evil.example/watch?v=dQw4w9WgXcQ',
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('is a 16:9 player, upright for shorts, with presentation and media features', () => {
    const size = youtube.size as (url: URL) => unknown
    expect(size(new URL('https://www.youtube.com/shorts/dQw4w9WgXcQ'))).toEqual({ ratio: '9/16' })
    expect(size(new URL('https://youtu.be/dQw4w9WgXcQ'))).toEqual({ ratio: '16/9' })
    expect(sandboxOf(youtube)).toBe(
      'allow-scripts allow-same-origin allow-popups allow-presentation',
    )
    expect(allowOf(youtube)).toBe('fullscreen; picture-in-picture; encrypted-media')
  })
})
