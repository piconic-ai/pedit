// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROVIDERS } from '@pedit/protocol/csp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  boxOf,
  boxStyle,
  checkBoxStyle,
  embedFor,
  frameFor,
  httpUrl,
  isAllowedFrame,
  providerOf,
  sizeHint,
} from '../src/embed.ts'

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
    // Shorts are filmed upright.
    const ratio = href.includes('/shorts/') ? [9, 16] : [16, 9]
    const box = { width: null, ratio }
    expect(embedFor(href)).toEqual({ kind: 'frame', src, provider, title, box, ...PLAYER })
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
      src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      provider: 'youtube',
      title: 'YouTube',
      ...PLAYER,
    })
    expect(frameFor('https://player.vimeo.com/video/1')).toEqual({
      src: 'https://player.vimeo.com/video/1',
      provider: 'vimeo',
      title: 'Vimeo',
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

describe('sizeHint', () => {
  const hint = (hash: string) => sizeHint(new URL(`https://youtu.be/dQw4w9WgXcQ${hash}`))

  it.each([
    ['#width=560&height=315', { width: 560, height: 315 }],
    ['#height=315&width=560', { width: 560, height: 315 }],
    ['#width=100%&height=400', { width: '100%', height: 400 }],
    ['#height=400&width=100%', { width: '100%', height: 400 }],
    ['#width=560', { width: 560 }],
    ['#height=400', { height: 400 }],
    ['#width=100%', { width: '100%' }],
    ['#width=100%25&height=400', { width: '100%', height: 400 }],
    // Out of range is clamped later, by boxOf.
    ['#width=0&height=99999', { width: 0, height: 99999 }],
    ['#width=1234567890', { width: 1234567890 }],
  ])('reads %s', (hash, want) => {
    expect(hint(hash)).toEqual(want)
  })

  it.each([
    '',
    '#',
    '#t=30',
    '#width=',
    '#width=560&',
    '#&width=560',
    '#width=560&height=315&x=1',
    '#x=1&width=560',
    '#width=560&width=600',
    '#height=315&height=400',
    '#height=100%',
    '#width=50%',
    '#width=100%2525',
    '#width=100%%',
    '#width=560px',
    '#width=-560',
    '#width=5.5',
    '#width=1e3',
    '#WIDTH=560',
    '#width=560;color:red',
    '#width=560&height=315;background:url(x)',
    '#width=560%3Bcolor:red',
    '#width=%20560',
  ])('ignores the fragment %j', (hash) => {
    expect(hint(hash)).toBeNull()
  })
})

describe('boxOf', () => {
  const video = { ratio: '16/9' } as const
  const bar = { height: 152 } as const

  it.each([
    ['the default ratio', video, null, { width: null, ratio: [16, 9] }],
    ['the default height', bar, null, { width: null, height: 152 }],
    ['a width with the ratio', video, { width: 560 }, { width: 560, ratio: [560, 315] }],
    ['a width with the height', bar, { width: 560 }, { width: 560, ratio: [560, 152] }],
    ['both', video, { width: 400, height: 300 }, { width: 400, ratio: [400, 300] }],
    ['a height with the ratio', video, { height: 315 }, { width: 560, ratio: [560, 315] }],
    ['a height for a bar', bar, { height: 200 }, { width: null, height: 200 }],
    [
      'the full width and a height',
      video,
      { width: '100%', height: 300 },
      { width: null, height: 300 },
    ],
    ['only the full width', video, { width: '100%' }, { width: null, ratio: [16, 9] }],
  ] as const)('takes %s', (_, size, hint, box) => {
    expect(boxOf(size, hint)).toEqual(box)
  })

  it.each([
    ['too narrow', { width: 50 }, { width: 100, ratio: [100, 100] }],
    ['too wide', { width: 99999 }, { width: 4000, ratio: [4000, 2250] }],
    ['too low', { width: 400, height: 10 }, { width: 400, ratio: [400, 100] }],
    ['too high', { width: 400, height: 99999 }, { width: 400, ratio: [400, 800] }],
    ['wider than 4:1', { width: 4000, height: 100 }, { width: 4000, ratio: [4000, 1000] }],
    ['taller than 1:2', { width: 300, height: 1000 }, { width: 300, ratio: [300, 600] }],
    ['a height too high', { height: 99999 }, { width: 4000, ratio: [4000, 4000] }],
    ['a height too low', { height: 0 }, { width: 178, ratio: [178, 100] }],
    [
      'with more digits than a number holds',
      { width: Infinity },
      { width: 4000, ratio: [4000, 2250] },
    ],
  ] as const)('clamps a size %s', (_, hint, box) => {
    expect(boxOf({ ratio: '16/9' }, hint)).toEqual(box)
  })

  it('clamps defaults no box may have', () => {
    expect(boxOf({ ratio: '10/1' }, null)).toEqual({ width: null, ratio: [4, 1] })
    expect(boxOf({ ratio: '1/9' }, null)).toEqual({ width: null, ratio: [1, 2] })
    expect(boxOf({ height: 20 }, null)).toEqual({ width: null, height: 100 })
    expect(boxOf({ height: 9000 }, null)).toEqual({ width: null, height: 4000 })
  })
  it('clamps a size with more digits than any limit', () => {
    for (const digits of ['1234567890', '9'.repeat(400)]) {
      const box = embedFor(`https://youtu.be/dQw4w9WgXcQ#width=${digits}`)
      expect(box).toMatchObject({ box: { width: 4000, ratio: [4000, 2250] } })
      expect(embedFor(`https://youtu.be/dQw4w9WgXcQ#height=${digits}`)).toMatchObject({
        box: { width: 4000, ratio: [4000, 4000] },
      })
    }
  })
})

describe('boxStyle and checkBoxStyle', () => {
  it('writes only custom properties from whole numbers', () => {
    expect(boxStyle({ width: null, ratio: [16, 9] })).toBe('--embed-rw:16;--embed-rh:9')
    expect(boxStyle({ width: 560, ratio: [560, 315] })).toBe(
      '--embed-w:560;--embed-rw:560;--embed-rh:315',
    )
    expect(boxStyle({ width: null, height: 152 })).toBe('--embed-h:152')
  })

  it('accepts whatever boxOf and boxStyle write', () => {
    const sizes = [
      { ratio: '16/9' },
      { ratio: '9/16' },
      { ratio: '10/1' },
      { height: 152 },
    ] as const
    const lengths = [undefined, 0, 99, 100, 315, 560, 4000, 99999]
    for (const size of sizes) {
      for (const width of [...lengths, '100%' as const]) {
        for (const height of lengths) {
          const style = boxStyle(boxOf(size, { width, height }))
          expect(checkBoxStyle(style), style).toBe(style)
        }
      }
    }
  })

  it.each([
    null,
    '',
    'color:red',
    '--embed-rw:16;--embed-rh:9;color:red',
    '--embed-w:560;--embed-rw:560;--embed-rh:315;',
    '--embed-rw:16;--embed-rh:9;--embed-w:560',
    ' --embed-rw:16;--embed-rh:9',
    '--embed-w:560',
    '--embed-w:560;--embed-h:300',
    '--embed-h:50',
    '--embed-h:4001',
    '--embed-w:99;--embed-rw:16;--embed-rh:9',
    '--embed-rw:10;--embed-rh:1',
    '--embed-rw:1;--embed-rh:3',
    '--embed-rw:0;--embed-rh:1',
    '--embed-rw:16;--embed-rh:0',
    '--embed-ratio:16/9',
    '--embed-rw:16',
    '--embed-rh:9',
    '--embed-rh:9;--embed-rw:16',
    '--embed-rw:16 ;--embed-rh:9',
    '--embed-h:300px',
    '--embed-h:calc(100vh)',
    '--embed-h:300;background:url(https://evil.example/)',
    '--embed-rw:16;--embed-rh:9}*{color:red',
  ])('refuses the style %j', (style) => {
    expect(checkBoxStyle(style)).toBeNull()
  })
})

describe('embed sizes', () => {
  const youtube = PROVIDERS.youtube as {
    size: (url: URL) => unknown
    embed: (url: URL) => string | null
  }

  it('gives each provider its default box, which may depend on the URL', () => {
    expect(embedFor('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({
      box: { width: null, ratio: [16, 9] },
    })
    expect(embedFor('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toMatchObject({
      box: { width: null, ratio: [9, 16] },
    })
    expect(embedFor('https://vimeo.com/76979871')).toMatchObject({
      box: { width: null, ratio: [16, 9] },
    })
  })

  it('sizes a player by the hint and never hands the hint to the provider', () => {
    const embed = vi.spyOn(youtube, 'embed')
    const out = embedFor('https://youtu.be/dQw4w9WgXcQ?t=90#height=300&width=400')
    expect(out).toMatchObject({
      src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90',
      box: { width: 400, ratio: [400, 300] },
    })
    expect(embed.mock.calls[0]?.[0].hash).toBe('')
    // A width alone keeps the provider's ratio for that URL.
    expect(embedFor('https://www.youtube.com/shorts/dQw4w9WgXcQ#width=300')).toMatchObject({
      box: { width: 300, ratio: [300, 533] },
    })
  })

  it('passes any other fragment on as before, and the frame drops it', () => {
    const embed = vi.spyOn(youtube, 'embed')
    const out = embedFor('https://youtu.be/dQw4w9WgXcQ#width=560;color:red')
    expect(embed.mock.calls[0]?.[0].hash).toBe('#width=560;color:red')
    expect(out).toMatchObject({
      src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      box: { width: null, ratio: [16, 9] },
    })
  })

  it('strips the hint from a video file', () => {
    expect(embedFor('https://example.com/clip.mp4#width=560')).toEqual({
      kind: 'video',
      src: 'https://example.com/clip.mp4',
    })
  })

  it.each([
    [
      'fails',
      () => {
        throw new Error('bad size')
      },
    ],
    ['answers no size', () => ({ ratio: '16/9;color:red' })],
    ['answers a height of zero', () => ({ height: 0 })],
  ])('falls back to 16:9 when a size function %s', (_, size) => {
    vi.spyOn(youtube, 'size').mockImplementation(size)
    expect(embedFor('https://youtu.be/dQw4w9WgXcQ')).toMatchObject({
      box: { width: null, ratio: [16, 9] },
    })
  })
})

// jsdom does no layout, so this holds the rule that keeps a box's ratio in place.
describe('the embed box in style.css', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/style.css'), 'utf8')
  const rule =
    /\n\.preview \.embed \{([^}]*aspect-ratio[^}]*)\}/.exec(css)?.[1]?.replace(/\s+/g, ' ') ?? ''

  it('narrows a ratio box with its 80vh height cap, so it keeps its ratio', () => {
    expect(rule).toContain('aspect-ratio: var(--embed-rw) / var(--embed-rh);')
    expect(rule).toContain('calc(80vh * var(--embed-rw, 4) / var(--embed-rh, 1))')
    expect(rule).toContain('max-height: min(80vh, 200cqw);')
  })

  it('keeps a height box within 4:1 and 1:2', () => {
    // At most four times as wide as its height, and at most twice as tall as the preview is wide.
    expect(rule).toContain('calc(var(--embed-h, 4000) * 4px)')
    expect(css).toMatch(/\n\.preview \{\s*container-type: inline-size;\s*\}/)
  })
})

describe('providerOf', () => {
  it('names the players by their key in the registry', () => {
    expect(providerOf('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=9')).toBe('youtube')
    expect(providerOf('https://player.vimeo.com/video/1?h=ab')).toBe('vimeo')
  })

  it("names a frame under any provider's frames with its key", () => {
    for (const [id, provider] of Object.entries(PROVIDERS)) {
      for (const frame of provider.frames) expect(providerOf(`${frame}123`)).toBe(id)
    }
  })

  it.each([
    null,
    'https://embed.example.com/v/1',
    'https://evil.example/',
    'https://player.vimeo.com/video/../x',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'not a url',
  ])('names nothing pedit would not frame: %j', (src) => {
    expect(providerOf(src)).toBeNull()
  })
})
