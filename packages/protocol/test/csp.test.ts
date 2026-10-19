import { describe, expect, it } from 'vitest'
import {
  AVATAR_HOSTS,
  allowsMedia,
  contentSecurityPolicy,
  coversOrigin,
  framedProviders,
  isSize,
  PROVIDERS,
  parseMediaSources,
  providerProblem,
} from '../src/csp.ts'
import { defineProvider, type Provider } from '../src/embeds/define.ts'

const FRAMES = Object.values(PROVIDERS).flatMap((p) => p.frames)

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

describe('coversOrigin', () => {
  const page = new URL('https://pedit.test/r/x')

  it.each([
    'pedit.test',
    'https://pedit.test',
    'http://pedit.test',
    'https://PEDIT.test/other/',
    'https://pedit.test:443',
    'http://pedit.test:80',
    'pedit.test:80',
    'pedit.test:*',
    'https://other.example pedit.test',
  ])('finds the page origin in %j', (value) => {
    expect(coversOrigin(value.split(' '), page)).toBe(true)
  })

  it('leaves a trailing-dot page host, another origin, alone', () => {
    expect(coversOrigin(['https://pedit.test'], new URL('https://pedit.test./'))).toBe(false)
  })

  it('finds a wildcard over the page host', () => {
    expect(coversOrigin(['*.pedit.test'], new URL('https://edit.pedit.test/'))).toBe(true)
  })

  it.each(['other.example', '*.pedit.test', 'https://pedit.test:8443', 'https://sub.pedit.test'])(
    'leaves other origins alone: %j',
    (value) => {
      expect(coversOrigin([value], page)).toBe(false)
    },
  )
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
    expect(
      contentSecurityPolicy({ scriptHashes: ['abc'], media: [], frames: FRAMES, origin }),
    ).toBe(
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
    const csp = contentSecurityPolicy({ scriptHashes: [], media: ['https:'], frames: [], origin })
    expect(csp).toMatch(/img-src [^;]* https:(;|$)/)
    expect(csp).toContain('media-src https:;')
  })

  it('uses ws on http origins', () => {
    const csp = contentSecurityPolicy({
      scriptHashes: [],
      media: [],
      frames: [],
      origin: new URL('http://localhost:8787/'),
    })
    expect(csp).toContain("connect-src 'self' ws://localhost:8787;")
  })

  it('lists every avatar host and player', () => {
    const csp = contentSecurityPolicy({ scriptHashes: [], media: [], frames: FRAMES, origin })
    const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? ''
    for (const host of AVATAR_HOSTS) expect(directive('img-src')).toContain(`https://${host}`)
    expect(directive('frame-src')).toBe(`frame-src ${FRAMES.join(' ')}`)
  })

  it('frames nothing without frames', () => {
    const csp = contentSecurityPolicy({ scriptHashes: [], media: [], frames: [], origin })
    expect(csp).toContain("frame-src 'none';")
  })
})

// A provider that passes every check, to vary one field at a time.
const good: Provider = {
  name: 'Example',
  frames: ['https://embed.example.com/v/'],
  size: { ratio: '16/9' },
}
const page = new URL('https://pedit.test/r/x')
const problem = (over: Record<string, unknown>, at = page) =>
  providerProblem({ ...good, ...over } as Provider, at)

describe('providerProblem', () => {
  it('passes a provider within the rules', () => {
    expect(problem({})).toBeNull()
    expect(
      problem({
        frames: ['https://embed.example.com/', 'https://cdn.example.com:8443/a/b/'],
        size: () => ({ height: 152 }),
        embed: () => null,
        sandbox: ['allow-presentation', 'allow-forms'],
        allow: ['fullscreen', 'autoplay'],
      }),
    ).toBeNull()
    expect(problem({ size: { height: 152 } })).toBeNull()
  })

  it.each(Object.keys(PROVIDERS))('passes the built-in provider %s on the public relay', (id) => {
    const provider = PROVIDERS[id as keyof typeof PROVIDERS]
    expect(providerProblem(provider, new URL('https://edit.piconic.ai/r/x'))).toBeNull()
    expect(providerProblem(provider, new URL('http://localhost:8787/r/x'))).toBeNull()
  })

  it.each([
    { name: '' },
    { name: '  ' },
    { name: undefined },
    { frames: [] },
    { frames: undefined },
    { size: undefined },
    { size: { ratio: '16:9' } },
    { size: { ratio: '0/9' } },
    { size: { height: 0 } },
    { size: { height: 1.5 } },
    { size: 'big' },
    { embed: 'https://embed.example.com/v/1' },
  ])('refuses %j', (over) => {
    expect(problem(over)).not.toBeNull()
  })

  it.each([
    // Not https, or no path ending in '/'.
    'http://embed.example.com/',
    'https://embed.example.com',
    'https://embed.example.com/v',
    'embed.example.com/',
    // Anything frame-src would read as more than one prefix, or as a keyword.
    'https://*.example.com/',
    'https://embed.example.com:*/',
    'https://embed.example.com/ https:/',
    "https://embed.example.com/'self'/",
    'https://embed.example.com/;script-src/',
    'https://embed.example.com/a,b/',
    // Not in the URL parser's own form.
    'https://Embed.example.com/',
    'https://embed.example.com:443/',
    'https://embed.example.com/a/../',
    'https://embed.example.com/%2e%2e/',
    'https://embed.example.com:99999/',
    // User-info, query and fragment.
    'https://u@embed.example.com/',
    'https://embed.example.com/?a=/',
    'https://embed.example.com/#/',
  ])('refuses frame %j', (frame) => {
    expect(problem({ frames: [frame] })).toMatch(/is not https/)
  })

  it.each([
    'allow-top-navigation',
    'allow-top-navigation-by-user-activation',
    'allow-top-navigation-to-custom-protocols',
    'allow-downloads',
    // Its popups could navigate the editor tab through opener.top.
    'allow-popups-to-escape-sandbox',
    'allow-scripts allow-top-navigation',
    'allow-forms ',
  ])('refuses sandbox token %j', (token) => {
    expect(problem({ sandbox: [token] })).toMatch(/sandbox/)
  })

  it.each(['camera', 'microphone', 'clipboard-read', 'geolocation', 'fullscreen; camera *'])(
    'refuses allow feature %j',
    (feature) => {
      expect(problem({ allow: [feature] })).toMatch(/allow/)
    },
  )

  it.each([
    'https://pedit.test/',
    'https://pedit.test/elsewhere/',
    // CSP3 lets :80 match https on its default port too.
    'https://pedit.test:80/',
  ])("refuses frames %j that cover the editor's own origin", (frame) => {
    expect(problem({ frames: ['https://embed.example.com/', frame] })).toMatch(/own origin/)
  })

  it('compares with the origin of the page, port and all', () => {
    expect(problem({ frames: ['https://pedit.test:8443/'] })).toBeNull()
    expect(problem({ frames: ['https://sub.pedit.test/'] })).toBeNull()
    const local = new URL('https://localhost:8443/r/x')
    expect(problem({ frames: ['https://localhost:8443/'] }, local)).toMatch(/own origin/)
    expect(problem({ frames: ['https://localhost/'] }, local)).toBeNull()
  })

  it('takes a trailing-dot host for another origin, as browsers do', () => {
    // pedit.test. and pedit.test are different origins, so neither page can be
    // read from a frame on the other.
    expect(
      problem({ frames: ['https://pedit.test/'] }, new URL('https://pedit.test./r/x')),
    ).toBeNull()
  })
})

describe('framedProviders', () => {
  it('frames the built-in providers, in order', () => {
    expect(framedProviders(page)).toEqual({ framed: Object.keys(PROVIDERS), refused: [] })
  })

  it('leaves out the providers that fail, and says why', () => {
    const providers = {
      a: defineProvider(good),
      self: defineProvider({ ...good, frames: ['https://pedit.test/embed/'] }),
      b: defineProvider({ ...good, frames: ['https://b.example/'] }),
    }
    expect(framedProviders(page, providers)).toEqual({
      framed: ['a', 'b'],
      refused: [{ id: 'self', reason: "its frames cover the editor's own origin" }],
    })
  })

  it("leaves out a built-in provider on that provider's own origin", () => {
    const [id = '', provider] = Object.entries(PROVIDERS)[0] ?? []
    const { framed, refused } = framedProviders(new URL(provider?.frames[0] ?? ''))
    expect(framed).not.toContain(id)
    expect(refused.map((r) => r.id)).toEqual([id])
  })
})

describe('isSize', () => {
  it.each([{ ratio: '16/9' }, { ratio: '9/16' }, { ratio: '1/1' }, { height: 152 }])(
    'takes %j',
    (size) => {
      expect(isSize(size)).toBe(true)
    },
  )

  it.each([
    null,
    undefined,
    '16/9',
    {},
    { ratio: '16:9' },
    { ratio: '0/9' },
    { ratio: '16/9;color:red' },
    { ratio: 16 / 9 },
    { height: 0 },
    { height: -1 },
    { height: 1.5 },
    { height: '152' },
  ])('refuses %j', (size) => {
    expect(isSize(size)).toBe(false)
  })
})
