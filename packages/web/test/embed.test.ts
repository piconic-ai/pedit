// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PROVIDERS } from '@pedit/protocol/csp'
import { allowOf, sandboxOf } from '@pedit/protocol/embeds/define'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  boxOf,
  boxStyle,
  checkBoxStyle,
  embedFor,
  frameFor,
  httpUrl,
  isAllowedFrame,
  linesAttr,
  providerOf,
  sizeHint,
  snippetFor,
} from '../src/embed.ts'

const PLAYER = {
  sandbox: 'allow-scripts allow-same-origin allow-popups allow-presentation',
  allow: 'fullscreen; picture-in-picture; encrypted-media',
}
const page = new URL('https://pedit.test/r/x')

// A player URL of each provider pedit ships, as its embed() builds it. A relay
// may add or drop providers, so the tests take the ones it registers.
const SHIPPED: Record<string, string> = {
  youtube: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
  vimeo: 'https://player.vimeo.com/video/1',
  loom: 'https://www.loom.com/embed/0123456789abcdef0123456789abcdef',
  figma: 'https://embed.figma.com/board/AbCdEfGhIjKlMnOpQrStUv?embed-host=pedit',
  codepen: 'https://codepen.io/u/embed/AbC123?default-tab=result',
  stackblitz: 'https://stackblitz.com/github/user/repo?embed=1',
  observable: 'https://observablehq.com/embed/@d3/bar-chart',
  spotify: 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
  soundcloud:
    'https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F293&auto_play=false',
  miro: 'https://miro.com/app/live-embed/uXjVOabcdEF=/',
}
const PLAYERS = Object.entries(SHIPPED).filter(([id]) => id in PROVIDERS)

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
    'https://youtu.be/dQw4w9WgXcQ?t=99999999999999999999999',
    // A compound start whose total is over six digits.
    'https://youtu.be/dQw4w9WgXcQ?t=278h',
  ])('frames a YouTube link whose start is too long to read, without the start: %s', (href) => {
    const out = embedFor(href, page)
    expect(out?.kind === 'frame' && out.src).toBe(yt)
  })

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
    for (const [id, src] of PLAYERS) {
      const provider = PROVIDERS[id as keyof typeof PROVIDERS]
      expect(frameFor(src)).toEqual({
        src,
        provider: id,
        title: provider.name,
        sandbox: sandboxOf(provider),
        allow: allowOf(provider),
      })
    }
  })

  it.each([
    // Under CodePen's frames, which are all of codepen.io, but no player.
    'https://codepen.io/login',
    'https://codepen.io/u/pen/AbC123',
    'https://codepen.io/u/embed/AbC123',
    // A SoundCloud player for something that is not SoundCloud's.
    'https://w.soundcloud.com/player/?url=https%3A//evil.example/1',
    // Parameters the provider's embed() would not pass on.
    'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1',
    'https://player.vimeo.com/video/1?h=ab&autoplay=1',
    'https://www.loom.com/embed/0123456789abcdef0123456789abcdef?autoplay=1',
    'https://embed.figma.com/board/AbCdEfGhIjKlMnOpQrStUv',
    'https://stackblitz.com/edit/x?embed=1&terminal=dev',
    'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=x',
    'https://miro.com/app/live-embed/uXjVOabcdEF=',
  ])('frames only player URLs the provider would build itself, not %s', (src) => {
    expect(frameFor(src)).toBeNull()
    expect(providerOf(src)).toBeNull()
  })
})

describe('the providers in the registry', () => {
  // A link someone shares, the player it becomes and the box it gets.
  it.each([
    [
      'https://www.loom.com/share/0123456789abcdef0123456789abcdef?sid=x',
      'loom',
      'https://www.loom.com/embed/0123456789abcdef0123456789abcdef',
      { width: null, ratio: [16, 9] },
    ],
    [
      'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/File?node-id=1-2&t=x',
      'figma',
      'https://embed.figma.com/design/AbCdEfGhIjKlMnOpQrStUv?embed-host=pedit&node-id=1-2',
      { width: null, ratio: [4, 3] },
    ],
    [
      'https://codepen.io/u/pen/AbC123',
      'codepen',
      'https://codepen.io/u/embed/AbC123?default-tab=result',
      { width: null, ratio: [4, 3] },
    ],
    [
      'https://stackblitz.com/edit/vitejs-vite-abc?file=src/main.ts',
      'stackblitz',
      'https://stackblitz.com/edit/vitejs-vite-abc?embed=1&file=src/main.ts',
      { width: null, ratio: [4, 3] },
    ],
    [
      'https://observablehq.com/@d3/bar-chart',
      'observable',
      'https://observablehq.com/embed/@d3/bar-chart',
      { width: null, ratio: [4, 3] },
    ],
    [
      'https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=x',
      'spotify',
      'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
      { width: null, height: 152 },
    ],
    [
      'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&auto_play=true',
      'soundcloud',
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F293&auto_play=false',
      { width: null, height: 166 },
    ],
    [
      'https://miro.com/app/board/uXjVOabcdEF=/?share_link_id=1',
      'miro',
      'https://miro.com/app/live-embed/uXjVOabcdEF=/',
      { width: null, ratio: [4, 3] },
    ],
  ])('frames %s as a %s player', (href, provider, src, box) => {
    const p = PROVIDERS[provider as keyof typeof PROVIDERS]
    expect(embedFor(href)).toEqual({
      kind: 'frame',
      src,
      provider,
      title: p.name,
      sandbox: sandboxOf(p),
      allow: allowOf(p),
      box,
    })
  })

  it('sizes them by a hint, which never reaches the provider', () => {
    expect(
      embedFor('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC#height=352'),
    ).toMatchObject({
      src: 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
      box: { width: null, height: 352 },
    })
    expect(embedFor('https://www.figma.com/board/AbCdEfGhIjKlMnOpQrStUv#width=800')).toMatchObject({
      src: 'https://embed.figma.com/board/AbCdEfGhIjKlMnOpQrStUv?embed-host=pedit',
      box: { width: 800, ratio: [800, 600] },
    })
  })

  it.each([
    'https://codepen.io.evil.example/u/pen/AbC123',
    'https://w.soundcloud.com/player/?url=https%3A//evil.example/tracks/293',
    'https://www.figma.com@evil.example/design/AbCdEfGhIjKlMnOpQrStUv',
    'https://codepen.io/login',
    'https://stackblitz.com/edit/x%2f..',
  ])('leaves %s a link', (href) => {
    expect(embedFor(href)).toBeNull()
  })

  it('never gives a frame top navigation, an escape from the sandbox or downloads', () => {
    for (const provider of Object.values(PROVIDERS)) {
      expect(sandboxOf(provider)).not.toMatch(/top-navigation|escape-sandbox|downloads/)
      expect(allowOf(provider)).not.toContain('clipboard-read')
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

  it("names each provider's players with its key", () => {
    for (const [id, src] of PLAYERS) expect(providerOf(src)).toBe(id)
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

describe('snippets', () => {
  const RAW = 'https://raw.githubusercontent.com/o/r/main/src/a.ts'
  const BLOB = 'https://github.com/o/r/blob/main/src/a.ts'
  const github = PROVIDERS.github

  it('takes a GitHub file as a snippet of its raw file, with no box', () => {
    expect(embedFor(BLOB)).toEqual({
      kind: 'snippet',
      src: RAW,
      lines: null,
      provider: 'github',
      title: 'GitHub',
    })
    expect(embedFor(`${BLOB}#L3-L9`)).toMatchObject({ src: RAW, lines: [3, 9] })
    expect(embedFor(`${BLOB}#L3`)).toMatchObject({ src: RAW, lines: [3, 3] })
    expect(embedFor(RAW)).toMatchObject({ kind: 'snippet', src: RAW, lines: null })
  })

  it('reads no size hint: GitHub names lines in the fragment', () => {
    for (const hash of ['#width=560', '#height=400', '#L9-L3']) {
      expect(embedFor(`${BLOB}${hash}`)).toEqual(embedFor(BLOB))
    }
  })

  it.each([
    'https://github.com/o/r/tree/main/src',
    'https://gist.github.com/o/0123456789abcdef',
    'https://github.com.evil.example/o/r/blob/main/a.ts',
    'https://github.com/o/r/blob/main/a%2fb.ts',
  ])('leaves %s a link', (href) => {
    expect(embedFor(href)).toBeNull()
  })

  it('writes and reads the lines of a placeholder', () => {
    expect(linesAttr([3, 9])).toBe('3-9')
    expect(snippetFor(RAW, '3-9', page)).toEqual({
      src: RAW,
      lines: [3, 9],
      provider: 'github',
      title: 'GitHub',
    })
    expect(snippetFor(RAW, null, page)).toMatchObject({ lines: null })
  })

  it.each(['', '9-3', '0-3', '3', '3-', '03-9', '1-1000001', '3-9 ', ' 3-9', '3-9;x', 'a-b'])(
    'refuses the lines %j',
    (lines) => {
      expect(snippetFor(RAW, lines, page)).toBeNull()
    },
  )

  it('rebuilds the src to fetch from the parsed URL, never the fragment', () => {
    expect(
      snippetFor('HTTPS://RAW.GITHUBUSERCONTENT.COM/o/r/main/x/../a.ts#L1', null, page),
    ).toMatchObject({ src: 'https://raw.githubusercontent.com/o/r/main/a.ts' })
  })

  it.each([
    null,
    'not a url',
    // Only srcs the provider would build itself: no query, no blob page.
    `${RAW}?token=x`,
    BLOB,
    'https://raw.githubusercontent.com/o/r/main',
    'https://raw.githubusercontent.com/o/r/main/a%2fb.ts',
    'https://u@raw.githubusercontent.com/o/r/main/a.ts',
    'http://raw.githubusercontent.com/o/r/main/a.ts',
    'https://raw.githubusercontent.com:444/o/r/main/a.ts',
    'https://gist.githubusercontent.com/o/1/raw/a.ts',
    // A player is no snippet.
    'https://player.vimeo.com/video/1',
  ])('fetches nothing for %j', (src) => {
    expect(snippetFor(src, null, page)).toBeNull()
  })

  it('names the provider of a snippet src', () => {
    expect(providerOf(RAW)).toBe('github')
    expect(providerOf(`${RAW}?x=1`)).toBeNull()
  })

  it("never fetches on the provider's own origin", () => {
    const raw = new URL('https://raw.githubusercontent.com/r/x')
    expect(snippetFor(RAW, null, raw)).toBeNull()
    expect(embedFor(BLOB, raw)).toBeNull()
    expect(embedFor('https://vimeo.com/76979871', raw)).toMatchObject({ provider: 'vimeo' })
  })

  it.each([
    { src: 'https://evil.example/o/r/main/a.ts' },
    { src: 'https://player.vimeo.com/video/1' },
    { src: RAW, lines: [3] },
    { src: RAW, lines: [9, 3] },
    { src: RAW, lines: [0, 3] },
    { src: 42 },
    'https://raw.githubusercontent.com/o/r/main/a.ts',
    null,
  ])('checks what snippet() answers again at runtime: %j is not fetched', (answer) => {
    vi.spyOn(github, 'snippet').mockReturnValue(answer as never)
    expect(embedFor(BLOB)).toBeNull()
  })

  it('may fail without breaking the preview', () => {
    vi.spyOn(github, 'snippet').mockImplementation(() => {
      throw new Error('bad provider')
    })
    expect(embedFor(BLOB)).toBeNull()
    expect(embedFor('https://vimeo.com/76979871')).toMatchObject({ provider: 'vimeo' })
  })

  it('fetches only what the provider builds again unchanged', () => {
    // A provider that builds a src it would not build from that src.
    vi.spyOn(github, 'snippet').mockImplementation((url) =>
      url.hostname === 'github.com' ? { src: `${RAW}x` } : null,
    )
    expect(embedFor(BLOB)).toBeNull()
  })
})
