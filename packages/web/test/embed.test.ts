// @vitest-environment jsdom
import { PROVIDERS } from '@pedit/protocol/csp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedFor, frameFor, httpUrl, isAllowedFrame } from '../src/embed.ts'

const PLAYER = {
  sandbox: 'allow-scripts allow-same-origin allow-popups allow-presentation',
  allow: 'fullscreen; picture-in-picture; encrypted-media',
}
const page = new URL('https://pedit.test/r/x')

afterEach(() => {
  vi.restoreAllMocks()
})

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
    const title = provider === 'vimeo' ? 'Vimeo' : 'YouTube'
    expect(embedFor(href)).toEqual({ kind: 'frame', src, provider, title, ...PLAYER })
  })

  it.each(['https://player.vimeo.com/video/abc/xyz', 'https://www.youtube-nocookie.com/embed/'])(
    'leaves player URL %s that names no video a link',
    (href) => {
      expect(embedFor(href)).toBeNull()
      expect(embedFor(href, page)).toBeNull()
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
    // A trailing dot is another origin; a homoglyph host parses to xn--.
    'https://player.vimeo.com./video/1',
    'https://www.youtube-nocookie.com./embed/dQw4w9WgXcQ',
    'https://pl\u0430yer.vimeo.com/video/1',
    'javascript:alert(1)//https://player.vimeo.com/video/1',
  ])('refuses %j', (src) => {
    expect(isAllowedFrame(src)).toBe(false)
  })
})

describe('frameFor', () => {
  it('derives each provider and its attributes from the src alone', () => {
    expect(frameFor('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toEqual({
      provider: 'youtube',
      title: 'YouTube',
      ...PLAYER,
    })
    expect(frameFor('https://player.vimeo.com/video/1')).toEqual({
      provider: 'vimeo',
      title: 'Vimeo',
      ...PLAYER,
    })
    expect(frameFor('https://embed.example.com/1')).toBeNull()
  })

  it('takes the attributes from the registry', () => {
    for (const [id, provider] of Object.entries(PROVIDERS)) {
      for (const prefix of provider.frames) {
        expect(frameFor(`${prefix}1`)).toMatchObject({ provider: id })
      }
    }
  })
})

describe("the editor's own origin", () => {
  const youtube = new URL('https://www.youtube-nocookie.com/r/x')

  it('never frames a provider whose frames cover it', () => {
    expect(frameFor('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', youtube)).toBeNull()
    expect(embedFor('https://youtu.be/dQw4w9WgXcQ', youtube)).toBeNull()
    expect(isAllowedFrame('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', youtube)).toBe(
      false,
    )
  })

  it('still frames the other providers', () => {
    expect(frameFor('https://player.vimeo.com/video/1', youtube)).toMatchObject({
      provider: 'vimeo',
    })
    expect(embedFor('https://vimeo.com/76979871', youtube)).toMatchObject({ provider: 'vimeo' })
  })

  it('frames every provider elsewhere', () => {
    for (const at of [page, new URL('http://localhost:8787/r/x')]) {
      expect(frameFor('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', at)).not.toBeNull()
      expect(frameFor('https://player.vimeo.com/video/1', at)).not.toBeNull()
    }
  })
})

describe("a provider's embed()", () => {
  const youtube = PROVIDERS.youtube as { embed: (url: URL) => string | null }

  it.each([
    // Another provider's player is not this provider's.
    'https://player.vimeo.com/video/1',
    'https://evil.example/embed/x',
    'http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'https://www.youtube-nocookie.com/embed/../watch',
    'https://www.youtube-nocookie.com/embed/..%2fwatch',
    'https://u@www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    'javascript:alert(1)',
    'not a url',
  ])('is checked again at runtime: %j is not framed', (src) => {
    vi.spyOn(youtube, 'embed').mockReturnValue(src)
    expect(embedFor('https://youtu.be/dQw4w9WgXcQ')).toBeNull()
  })

  it('may fail without breaking the preview', () => {
    vi.spyOn(youtube, 'embed').mockImplementation(() => {
      throw new Error('bad provider')
    })
    expect(embedFor('https://youtu.be/dQw4w9WgXcQ')).toBeNull()
    expect(embedFor('https://vimeo.com/76979871')).toMatchObject({ provider: 'vimeo' })
  })

  it('works on a copy of the URL', () => {
    vi.spyOn(youtube, 'embed').mockImplementation((url) => {
      url.hostname = 'evil.example'
      return null
    })
    expect(embedFor('https://vimeo.com/76979871')).toMatchObject({ provider: 'vimeo' })
  })
})
