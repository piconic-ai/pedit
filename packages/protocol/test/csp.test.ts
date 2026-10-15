import { describe, expect, it } from 'vitest'
import {
  AVATAR_HOSTS,
  allowsMedia,
  contentSecurityPolicy,
  FRAME_PREFIXES,
  parseMediaSources,
} from '../src/csp.ts'

describe('parseMediaSources', () => {
  it.each([
    [undefined, []],
    ['', []],
    ['  ', []],
    ['https:', ['https:']],
    ['https: https://img.example.com', ['https:', 'https://img.example.com']],
    ['*.example.com', ['*.example.com']],
    ['https://example.com:8443/pics/', ['https://example.com:8443/pics/']],
    ['http://192.168.1.10', ['http://192.168.1.10']],
  ])('accepts %j', (value, expected) => {
    expect(parseMediaSources(value)).toEqual(expected)
  })

  it.each([
    'https:; script-src *',
    "'unsafe-inline'",
    '*',
    'data:',
    'blob:',
    'javascript:',
    'https://a.com"',
    'https://a.com,b.com',
    'wss://x',
    'https://a.com/?q=1',
    'https://[::1]',
    Array.from({ length: 33 }, (_, i) => `h${i}.example.com`).join(' '),
  ])('rejects %j', (value) => {
    expect(parseMediaSources(value)).toBeNull()
  })
})

describe('allowsMedia', () => {
  const page = new URL('https://pedit.test/r/x')
  const ok = (sources: string[], url: string, from = page) =>
    allowsMedia(sources, new URL(url), from)

  it('matches scheme sources', () => {
    expect(ok(['https:'], 'https://x/a.png')).toBe(true)
    expect(ok(['https:'], 'http://x/a.png')).toBe(false)
    expect(ok(['http:'], 'http://x/a.png')).toBe(true)
    expect(ok(['http:'], 'https://x/a.png')).toBe(true)
  })

  it('matches wildcard hosts on subdomains only', () => {
    expect(ok(['*.example.com'], 'https://a.example.com/a.png')).toBe(true)
    expect(ok(['*.example.com'], 'https://example.com/a.png')).toBe(false)
  })

  it('matches paths', () => {
    expect(ok(['https://example.com/pics/'], 'https://example.com/pics/a.png')).toBe(true)
    expect(ok(['https://example.com/pics/'], 'https://example.com/other.png')).toBe(false)
    expect(ok(['https://example.com/a.png'], 'https://example.com/a.png')).toBe(true)
    expect(ok(['https://example.com/a.png'], 'https://example.com/a.png2')).toBe(false)
  })

  it('matches ports', () => {
    expect(ok(['https://example.com:8443'], 'https://example.com:8443/a.png')).toBe(true)
    expect(ok(['https://example.com:8443'], 'https://example.com/a.png')).toBe(false)
    expect(ok(['https://example.com'], 'https://example.com:8443/a.png')).toBe(false)
    expect(ok(['https://example.com:*'], 'https://example.com:8443/a.png')).toBe(true)
    expect(ok(['https://example.com:443'], 'https://example.com/a.png')).toBe(true)
  })

  it('takes the page scheme for a source without one', () => {
    expect(ok(['example.com'], 'https://example.com/a.png')).toBe(true)
    expect(ok(['example.com'], 'http://example.com/a.png')).toBe(false)
    expect(ok(['example.com'], 'http://example.com/a.png', new URL('http://localhost/'))).toBe(true)
  })

  it('ignores case in the host', () => {
    expect(ok(['https://Example.COM'], 'https://example.com/a.png')).toBe(true)
  })

  it('allows nothing without sources', () => {
    expect(ok([], 'https://example.com/a.png')).toBe(false)
  })
})

describe('contentSecurityPolicy', () => {
  const origin = new URL('https://pedit.test/r/abc')

  it('builds the strict policy', () => {
    expect(contentSecurityPolicy({ scriptHashes: ['abc'], media: [], origin })).toBe(
      [
        "default-src 'none'",
        "script-src 'self' 'sha256-abc'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' blob: data: https://gravatar.com https://www.gravatar.com https://secure.gravatar.com https://avatars.githubusercontent.com https://lh3.googleusercontent.com",
        "media-src 'none'",
        'frame-src https://www.youtube-nocookie.com/embed/ https://player.vimeo.com/video/',
        "connect-src 'self' wss://pedit.test",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    )
  })

  it('adds the media sources to img-src and media-src', () => {
    const csp = contentSecurityPolicy({ scriptHashes: [], media: ['https:'], origin })
    expect(csp).toMatch(/img-src [^;]* https:(;|$)/)
    expect(csp).toContain('media-src https:;')
  })

  it('uses ws on http origins', () => {
    const csp = contentSecurityPolicy({
      scriptHashes: [],
      media: [],
      origin: new URL('http://localhost:8787/'),
    })
    expect(csp).toContain("connect-src 'self' ws://localhost:8787;")
  })

  it('lists every avatar host and player', () => {
    const csp = contentSecurityPolicy({ scriptHashes: [], media: [], origin })
    const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? ''
    for (const host of AVATAR_HOSTS) expect(directive('img-src')).toContain(`https://${host}`)
    for (const prefix of FRAME_PREFIXES) expect(directive('frame-src')).toContain(prefix)
  })
})
