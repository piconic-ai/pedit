import { describe, expect, it } from 'vitest'
import { embedFor, frameFor, httpUrl, isAllowedFrame, providerOf } from '../src/embed.ts'

const PLAYER = {
  shape: 'video',
  sandbox: 'allow-scripts allow-same-origin allow-popups allow-presentation',
  allow: 'fullscreen; picture-in-picture; encrypted-media',
}
const CUSTOM = {
  shape: 'video',
  sandbox: 'allow-scripts allow-same-origin allow-popups',
  allow: '',
}
const page = new URL('https://pedit.test/r/x')

describe('httpUrl', () => {
  it.each([
    ['https://example.com/a.png', true],
    ['http://example.com/a.png', true],
    ['images/a.png', false],
    ['/images/a.png', false],
    ['../a.png', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['data:image/png;base64,AAAA', false],
  ])('%s -> %s', (href, ok) => {
    expect(httpUrl(href) !== null).toBe(ok)
  })
})

describe('embedFor', () => {
  const yt = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', yt],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&list=x', yt],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', yt],
    ['https://youtu.be/dQw4w9WgXcQ', yt],
    ['https://youtu.be/dQw4w9WgXcQ?t=90', `${yt}?start=90`],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s', `${yt}?start=90`],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', yt],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', yt],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
    ['https://vimeo.com/76979871/abc123', 'https://player.vimeo.com/video/76979871?h=abc123'],
    [
      'https://player.vimeo.com/video/76979871?h=abc123',
      'https://player.vimeo.com/video/76979871?h=abc123',
    ],
  ])('frames %s', (href, src) => {
    const provider = src.includes('vimeo') ? 'vimeo' : 'youtube'
    const title = provider === 'vimeo' ? 'Vimeo video' : 'YouTube video'
    expect(embedFor(href)).toEqual({ kind: 'frame', src, provider, title, ...PLAYER })
  })

  it("frames a URL from the relay's frame sources as it is", () => {
    const custom = { sources: ['https://embed.example.com/v/'], page }
    expect(embedFor('https://embed.example.com/v/1?x=2', custom)).toEqual({
      kind: 'frame',
      src: 'https://embed.example.com/v/1?x=2',
      provider: 'custom',
      title: 'embed.example.com',
      ...CUSTOM,
    })
    expect(embedFor('https://embed.example.com/other', custom)).toBeNull()
    expect(embedFor('https://embed.example.com/v/1')).toBeNull()
    // The built-in players keep their own attributes.
    const all = { sources: ['player.vimeo.com'], page }
    expect(embedFor('https://vimeo.com/76979871', all)).toMatchObject({ provider: 'vimeo' })
  })

  it.each(['https://player.vimeo.com/video/abc/xyz', 'https://www.youtube-nocookie.com/embed/'])(
    'leaves player URL %s that names no video a link, with or without frame sources',
    (href) => {
      expect(embedFor(href)).toBeNull()
      expect(embedFor(href, { sources: [], page })).toBeNull()
    },
  )

  it.each([
    'https://example.com/clip.mp4',
    'https://example.com/clip.WEBM?token=1',
    'http://example.com/clip.mov',
  ])('plays video file %s', (href) => {
    expect(embedFor(href)).toEqual({ kind: 'video', src: new URL(href).href })
  })

  it.each([
    'https://example.com/',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ"onload="x',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    'https://vimeo.com/channels/staffpicks',
    'clip.mp4',
    'javascript:alert(1)//.mp4',
  ])('ignores %s', (href) => {
    expect(embedFor(href)).toBeNull()
  })
})

describe('isAllowedFrame', () => {
  it.each([
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90',
    'https://player.vimeo.com/video/1',
    'https://player.vimeo.com/video/1?h=abc',
    // The URL parser normalises scheme and host case, the default port and dot
    // segments that stay inside the prefix.
    'HTTPS://PLAYER.VIMEO.COM/video/1',
    'https://player.vimeo.com:443/video/1',
    'https://player.vimeo.com/video/x/../1',
  ])('allows %s', (src) => {
    expect(isAllowedFrame(src)).toBe(true)
  })

  it.each([
    null,
    '',
    'not a url',
    '/video/1',
    'https://evil.example/embed/',
    // Dot segments, plain or encoded, leaving the prefix.
    'https://player.vimeo.com/video/../x',
    'https://player.vimeo.com/video/%2e%2e/x',
    'https://player.vimeo.com/video/.%2E/x',
    'https://www.youtube-nocookie.com/embed/..%2fwatch',
    'https://www.youtube-nocookie.com/embed/..%5Cwatch',
    'https://player.vimeo.com/video\\..\\x',
    // User-info.
    'https://user@player.vimeo.com/video/1',
    'https://user:pass@www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com@evil.example/embed/x',
    // Scheme, port and path case.
    'http://player.vimeo.com/video/1',
    'https://player.vimeo.com:8443/video/1',
    'https://player.vimeo.com/VIDEO/1',
    'https://player.vimeo.com/videos/1',
    'https://player.vimeo.com/',
    // Look-alike hosts.
    'https://player.vimeo.com.evil.example/video/1',
    'https://evilplayer.vimeo.com/video/1',
    'https://player-vimeo.com/video/1',
    'https://youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com.evil.example/embed/x',
    'javascript:alert(1)//https://player.vimeo.com/video/1',
  ])('refuses %j', (src) => {
    expect(isAllowedFrame(src)).toBe(false)
  })
})

describe('frameFor', () => {
  it('derives each provider and its attributes from the src alone', () => {
    expect(frameFor('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toEqual({
      src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      provider: 'youtube',
      title: 'YouTube video',
      ...PLAYER,
    })
    expect(frameFor('https://player.vimeo.com/video/1')).toEqual({
      src: 'https://player.vimeo.com/video/1',
      provider: 'vimeo',
      title: 'Vimeo video',
      ...PLAYER,
    })
    expect(frameFor('https://embed.example.com/1')).toBeNull()
  })

  it('rebuilds the src to load from the allowed prefix and the parsed path', () => {
    expect(frameFor('https://www.youtube-nocookie.com/embed/x/../dQw4w9WgXcQ?start=5#t')?.src).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=5',
    )
    expect(frameFor('HTTPS://PLAYER.VIMEO.COM/video/1?h=ab')?.src).toBe(
      'https://player.vimeo.com/video/1?h=ab',
    )
  })

  describe("with the relay's frame sources", () => {
    const custom = (sources: string[], from = page) => ({ sources, page: from })

    it('frames what they match, with the custom attributes', () => {
      expect(
        frameFor('https://embed.example.com:8443/1', custom(['embed.example.com:8443'])),
      ).toEqual({
        src: 'https://embed.example.com:8443/1',
        provider: 'custom',
        title: 'embed.example.com:8443',
        ...CUSTOM,
      })
      expect(frameFor('https://a.example.com/1', custom(['*.example.com']))).toMatchObject({
        provider: 'custom',
      })
      expect(frameFor('https://example.com/1', custom(['*.example.com']))).toBeNull()
      expect(frameFor('https://embed.example.com/1', custom([]))).toBeNull()
    })

    it('applies the same URL checks as for the players', () => {
      const c = custom(['https://embed.example.com/v/'])
      expect(frameFor('https://embed.example.com/v/1', c)).not.toBeNull()
      expect(frameFor('https://embed.example.com/v/../x', c)).toBeNull()
      expect(frameFor('https://embed.example.com/v/%2e%2e/x', c)).toBeNull()
      expect(frameFor('https://embed.example.com/v/..%2fx', c)).toBeNull()
      expect(frameFor('https://u:p@embed.example.com/v/1', c)).toBeNull()
      expect(frameFor('https://embed.example.com.evil.test/v/1', c)).toBeNull()
    })

    it('takes http only from a source that names it', () => {
      expect(frameFor('http://embed.example.com/', custom(['embed.example.com']))).toBeNull()
      expect(frameFor('http://embed.example.com/', custom(['http://embed.example.com']))).toEqual({
        src: 'http://embed.example.com/',
        provider: 'custom',
        title: 'embed.example.com',
        ...CUSTOM,
      })
    })

    it("never frames the page's own origin", () => {
      expect(frameFor('https://pedit.test/r/y', custom(['pedit.test']))).toBeNull()
      expect(frameFor('https://pedit.test/', custom(['https:']))).toBeNull()
      expect(
        frameFor(
          'http://localhost:8787/',
          custom(['http://localhost:8787'], new URL('http://localhost:8787/r/x')),
        ),
      ).toBeNull()
      expect(frameFor('https://other.test/', custom(['other.test']))).not.toBeNull()
    })
  })
})

describe('providerOf', () => {
  const custom = { sources: ['https://embed.example.com/v/', 'http://local.test:8080'], page }

  it('names the players by provider', () => {
    expect(providerOf('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=9')).toBe('youtube')
    expect(providerOf('https://player.vimeo.com/video/1?h=ab', custom)).toBe('vimeo')
  })

  it('names a frame source by its origin alone', () => {
    expect(providerOf('https://embed.example.com/v/1?x=2#t', custom)).toBe(
      'custom:https://embed.example.com',
    )
    expect(providerOf('http://local.test:8080/a', custom)).toBe('custom:http://local.test:8080')
  })

  it.each([
    null,
    'https://embed.example.com/other',
    'https://evil.example/',
    'https://player.vimeo.com/video/../x',
    'not a url',
  ])('names nothing pedit would not frame: %j', (src) => {
    expect(providerOf(src, custom)).toBeNull()
  })
})
