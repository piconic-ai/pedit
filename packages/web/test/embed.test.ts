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

// The built-in providers besides YouTube and Vimeo. Each takes the links people
// share and its player's own URL, and rebuilds the player URL from the ids alone.

const POPUPS = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox'
const src = (href: string) => {
  const embed = embedFor(href)
  return embed?.kind === 'frame' ? embed.src : null
}

/** The same link on hosts that only look like the provider's, with user-info or a port, or not on the web. */
function impostors(href: string): string[] {
  const url = new URL(href)
  const { host } = url
  const path = `${url.pathname}${url.search}`
  return [
    `https://evil-${host}${path}`,
    `https://${host}.evil.com${path}`,
    `https://x${host}${path}`,
    `https://${host}.${path}`,
    `https://${host}@evil.com${path}`,
    `https://user@${host}${path}`,
    `https://user:pass@${host}${path}`,
    `https://${host}:8443${path}`,
    `javascript:alert(1)//${host}${path}`,
    `data:text/html,${host}${path}`,
    `ftp://${host}${path}`,
  ]
}

describe('Loom', () => {
  const id = '0123456789abcdef0123456789abcdef'
  const player = `https://www.loom.com/embed/${id}`

  it.each([
    [`https://www.loom.com/share/${id}`, player],
    [`https://loom.com/share/${id}`, player],
    [`https://www.loom.com/share/${id}/`, player],
    [`https://www.loom.com/share/${id}?sid=abc#x`, player],
    [`https://www.loom.com/share/${id}?t=30&sid=abc`, `${player}?t=30`],
    [`https://www.loom.com/share/${id}?t=1m30s`, player],
    [`https://www.loom.com/embed/${id}`, player],
    [`https://loom.com/embed/${id}?autoplay=1&hide_owner=true`, player],
    [`https://www.loom.com/embed/x/../../share/${id}`, player],
    [`HTTPS://WWW.LOOM.COM/share/${id}`, player],
    [`http://www.loom.com/share/${id}`, player],
  ])('frames %s', (href, want) => {
    expect(src(href)).toBe(want)
  })

  it.each([
    ...impostors(`https://www.loom.com/share/${id}`),
    `https://www.loom.com/share/${id.slice(1)}`,
    `https://www.loom.com/share/${id}0`,
    `https://www.loom.com/share/${id.toUpperCase()}`,
    `https://www.loom.com/share/${id.slice(2)}%2F`,
    `https://www.loom.com/share/folder/${id}`,
    `https://www.loom.com/share/%2e%2e/${id}`,
    `https://www.loom.com/looms/${id}`,
    `https://app.loom.com/share/${id}`,
    `https://www.loom.com/${id}`,
  ])('leaves %s a link', (href) => {
    expect(src(href)).toBeNull()
  })
})

describe('Figma', () => {
  const key = 'AbCdEfGhIjKlMnOpQrStUv'
  const at = (type: string, query = '') =>
    `https://embed.figma.com/${type}/${key}?embed-host=pedit${query}`

  it.each([
    [`https://www.figma.com/design/${key}/My-File?node-id=1-2&t=abc`, at('design', '&node-id=1-2')],
    [`https://figma.com/design/${key}`, at('design')],
    [`https://www.figma.com/design/${key}/My-File/`, at('design')],
    [`https://www.figma.com/design/${key}/My-File?m=dev#x`, at('design')],
    [`https://www.figma.com/file/${key}/Legacy`, at('design')],
    [`https://www.figma.com/board/${key}/Board`, at('board')],
    [`https://www.figma.com/slides/${key}/Talk`, at('slides')],
    [`https://www.figma.com/deck/${key}/Talk`, at('deck')],
    [
      `https://www.figma.com/proto/${key}/App?node-id=1-2&starting-point-node-id=3%3A4&scaling=min-zoom`,
      at('proto', '&node-id=1-2&starting-point-node-id=3:4'),
    ],
    [`https://www.figma.com/design/${key}/x?node-id=1-2%22onload`, at('design')],
    [`https://www.figma.com/design/${key}/x?node-id=../1`, at('design')],
    [
      `https://embed.figma.com/design/${key}/x?embed-host=other&node-id=5-6`,
      at('design', '&node-id=5-6'),
    ],
    [`https://embed.figma.com/proto/${key}?embed-host=pedit`, at('proto')],
    [`HTTPS://WWW.FIGMA.COM/design/${key}`, at('design')],
    [`http://www.figma.com/design/${key}`, at('design')],
  ])('frames %s', (href, want) => {
    expect(src(href)).toBe(want)
  })

  it.each([
    ...impostors(`https://www.figma.com/design/${key}/x`),
    ...impostors(`https://embed.figma.com/design/${key}`),
    `https://www.figma.com/design/${key.slice(1)}/x`,
    `https://www.figma.com/design/${key}-x/y`,
    `https://www.figma.com/design/${key}%2Fx`,
    `https://www.figma.com/design/%2e%2e/${key}`,
    `https://www.figma.com/design/${key}/branch/${key}/x`,
    `https://www.figma.com/community/file/${key}`,
    `https://www.figma.com/embed?embed_host=x&url=https://www.figma.com/design/${key}`,
    `https://embed.figma.com/file/${key}`,
    `https://www.embed.figma.com/design/${key}`,
    `https://help.figma.com/design/${key}`,
  ])('leaves %s a link', (href) => {
    expect(src(href)).toBeNull()
  })
})

describe('CodePen', () => {
  const player = 'https://codepen.io/some_user-1/embed/AbC123?default-tab=result'

  it.each([
    ['https://codepen.io/some_user-1/pen/AbC123', player],
    ['https://codepen.io/some_user-1/pen/AbC123/', player],
    ['https://codepen.io/some_user-1/embed/AbC123', player],
    ['https://codepen.io/some_user-1/full/AbC123', player],
    ['https://codepen.io/some_user-1/details/AbC123?editors=1010#x', player],
    ['https://codepen.io/some_user-1/pen/AbC123?theme-id=dark&default-tab=evil', player],
    [
      'https://codepen.io/some_user-1/embed/AbC123?default-tab=css,result',
      'https://codepen.io/some_user-1/embed/AbC123?default-tab=css,result',
    ],
    ['HTTPS://CODEPEN.IO/some_user-1/pen/AbC123', player],
    ['http://codepen.io/some_user-1/pen/AbC123', player],
  ])('frames %s', (href, want) => {
    expect(src(href)).toBe(want)
  })

  it.each([
    ...impostors('https://codepen.io/some_user-1/pen/AbC123'),
    'https://www.codepen.io/some_user-1/pen/AbC123',
    'https://codepen.io/some_user-1/pen/AbC-123',
    'https://codepen.io/some_user-1/pen/',
    'https://codepen.io/some_user-1/pen/AbC123%2Fx',
    'https://codepen.io/some_user-1/pen/%2e%2e',
    'https://codepen.io/team/some-team/pen/AbC123',
    'https://codepen.io/some_user-1/collection/AbC123',
    'https://codepen.io/some_user-1',
    `https://codepen.io/${'u'.repeat(65)}/pen/AbC123`,
    `https://codepen.io/u/pen/${'a'.repeat(33)}`,
    'https://cdpn.io/some_user-1/pen/AbC123',
  ])('leaves %s a link', (href) => {
    expect(src(href)).toBeNull()
  })
})

describe('StackBlitz', () => {
  const edit = 'https://stackblitz.com/edit/vitejs-vite-abc?embed=1'
  const repo = 'https://stackblitz.com/github/some-org/my.repo'

  it.each([
    ['https://stackblitz.com/edit/vitejs-vite-abc', edit],
    ['https://stackblitz.com/edit/vitejs-vite-abc/', edit],
    ['https://stackblitz.com/edit/vitejs-vite-abc?embed=1&hideNavigation=1&ctl=1', edit],
    ['https://stackblitz.com/edit/vitejs-vite-abc?file=src/main.ts', `${edit}&file=src/main.ts`],
    ['https://stackblitz.com/edit/vitejs-vite-abc?file=src%2Fmain.ts', `${edit}&file=src/main.ts`],
    [
      'https://stackblitz.com/edit/vitejs-vite-abc?file=.eslintrc.json',
      `${edit}&file=.eslintrc.json`,
    ],
    ['https://stackblitz.com/edit/vitejs-vite-abc?file=../x', edit],
    ['https://stackblitz.com/edit/vitejs-vite-abc?file=src/../../x', edit],
    ['https://stackblitz.com/edit/vitejs-vite-abc?file=/etc/passwd', edit],
    ['https://stackblitz.com/edit/vitejs-vite-abc?file=a%26b', edit],
    ['https://stackblitz.com/edit/vitejs-vite-abc?view=preview', `${edit}&view=preview`],
    ['https://stackblitz.com/edit/vitejs-vite-abc?view=evil', edit],
    [`${repo}`, `${repo}?embed=1`],
    [`${repo}/tree/main/examples/basic`, `${repo}/tree/main/examples/basic?embed=1`],
    ['HTTPS://STACKBLITZ.COM/edit/vitejs-vite-abc', edit],
    ['http://stackblitz.com/edit/vitejs-vite-abc', edit],
  ])('frames %s', (href, want) => {
    expect(src(href)).toBe(want)
  })

  it.each([
    ...impostors('https://stackblitz.com/edit/vitejs-vite-abc'),
    'https://www.stackblitz.com/edit/vitejs-vite-abc',
    'https://stackblitz.com/edit/',
    'https://stackblitz.com/edit/a.b',
    'https://stackblitz.com/edit/a%2Fb',
    'https://stackblitz.com/edit/%2e%2e',
    'https://stackblitz.com/edit/a/b',
    'https://stackblitz.com/fork/vitejs-vite-abc',
    'https://stackblitz.com/github/some-org',
    'https://stackblitz.com/github/.hidden/repo',
    'https://stackblitz.com/github/some-org/repo/blob/main/x',
    'https://stackblitz.com/github/some-org/repo/tree',
  ])('leaves %s a link', (href) => {
    expect(src(href)).toBeNull()
  })
})

describe('Observable', () => {
  const player = 'https://observablehq.com/embed/@d3/bar-chart'

  it.each([
    ['https://observablehq.com/@d3/bar-chart', player],
    ['https://observablehq.com/@d3/bar-chart/', player],
    ['https://observablehq.com/@d3/bar-chart?intent=fork#x', player],
    ['https://observablehq.com/embed/@d3/bar-chart', player],
    [
      'https://observablehq.com/embed/@d3/bar-chart?cells=chart,legend',
      `${player}?cells=chart,legend`,
    ],
    ['https://observablehq.com/embed/@d3/bar-chart?cells=$x,_y', `${player}?cells=$x,_y`],
    ['https://observablehq.com/embed/@d3/bar-chart?cells=1chart', player],
    ['https://observablehq.com/embed/@d3/bar-chart?cells=chart;alert(1)', player],
    ['https://observablehq.com/embed/@d3/bar-chart?cells=chart,', player],
    // The URL parser resolves an encoded dot segment as it does a plain one.
    ['https://observablehq.com/embed/%2e%2e/@d3/bar-chart', player],
    ['HTTPS://OBSERVABLEHQ.COM/@d3/bar-chart', player],
    ['http://observablehq.com/@d3/bar-chart', player],
  ])('frames %s', (href, want) => {
    expect(src(href)).toBe(want)
  })

  it.each([
    ...impostors('https://observablehq.com/@d3/bar-chart'),
    'https://www.observablehq.com/@d3/bar-chart',
    'https://observablehq.com/@d3',
    'https://observablehq.com/d3/bar-chart',
    'https://observablehq.com/embed/d3/bar-chart',
    'https://observablehq.com/d/0123456789abcdef',
    'https://observablehq.com/@d3/bar-chart/2',
    'https://observablehq.com/@d3/bar.chart',
    'https://observablehq.com/@d3%2Fbar-chart',
    'https://observablehq.com/embed/%2e%2e/%2e%2e/x',
    'https://d3.observablehq.cloud/@d3/bar-chart',
  ])('leaves %s a link', (href) => {
    expect(src(href)).toBeNull()
  })
})

describe('Spotify', () => {
  const id = '4uLU6hMCjMI75M1A2tKUQC'

  it.each([
    [`https://open.spotify.com/track/${id}`, `https://open.spotify.com/embed/track/${id}`],
    [`https://open.spotify.com/track/${id}/`, `https://open.spotify.com/embed/track/${id}`],
    [`https://open.spotify.com/track/${id}?si=abc#x`, `https://open.spotify.com/embed/track/${id}`],
    [`https://open.spotify.com/intl-de/track/${id}`, `https://open.spotify.com/embed/track/${id}`],
    [
      `https://open.spotify.com/intl-pt-BR/album/${id}`,
      `https://open.spotify.com/embed/album/${id}`,
    ],
    [`https://open.spotify.com/playlist/${id}`, `https://open.spotify.com/embed/playlist/${id}`],
    [`https://open.spotify.com/artist/${id}`, `https://open.spotify.com/embed/artist/${id}`],
    [`https://open.spotify.com/episode/${id}`, `https://open.spotify.com/embed/episode/${id}`],
    [`https://open.spotify.com/show/${id}`, `https://open.spotify.com/embed/show/${id}`],
    [
      `https://open.spotify.com/embed/track/${id}?utm_source=generator&theme=0`,
      `https://open.spotify.com/embed/track/${id}`,
    ],
    [`https://open.spotify.com/x/%2e%2e/track/${id}`, `https://open.spotify.com/embed/track/${id}`],
    [`HTTPS://OPEN.SPOTIFY.COM/track/${id}`, `https://open.spotify.com/embed/track/${id}`],
    [`http://open.spotify.com/track/${id}`, `https://open.spotify.com/embed/track/${id}`],
  ])('frames %s', (href, want) => {
    expect(src(href)).toBe(want)
  })

  it.each([
    ...impostors(`https://open.spotify.com/track/${id}`),
    `https://www.open.spotify.com/track/${id}`,
    `https://spotify.com/track/${id}`,
    `https://play.spotify.com/track/${id}`,
    `https://spotify.link/${id}`,
    `spotify:track:${id}`,
    `https://open.spotify.com/track/${id.slice(1)}`,
    `https://open.spotify.com/track/${id}x`,
    `https://open.spotify.com/track/${id.slice(3)}%2F`,
    `https://open.spotify.com/user/${id}`,
    `https://open.spotify.com/embed/intl-de/track/${id}`,
    `https://open.spotify.com/intl-de/embed/track/${id}`,
    `https://open.spotify.com/track/%2e%2e/${id}`,
  ])('leaves %s a link', (href) => {
    expect(src(href)).toBeNull()
  })
})

describe('SoundCloud', () => {
  const track =
    'https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F293&auto_play=false'
  const list =
    'https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Fplaylists%2F42&auto_play=false'
  const at = (url: string, rest = '') => `https://w.soundcloud.com/player/?url=${url}${rest}`

  it.each([
    [at('https%3A//api.soundcloud.com/tracks/293'), track],
    [
      at(
        'https%3A//api.soundcloud.com/tracks/293',
        '&color=%23ff5500&auto_play=true&visual=true#x',
      ),
      track,
    ],
    [at('https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F293'), track],
    [at('https://api.soundcloud.com/tracks/293'), track],
    [at('https%3A//api.soundcloud.com/tracks/soundcloud%253Atracks%253A293'), track],
    [at('https%3A//api.soundcloud.com/playlists/42'), list],
    [at('https%3A//api.soundcloud.com/playlists/soundcloud%253Aplaylists%253A42'), list],
    [`https://w.soundcloud.com/player?url=https%3A//api.soundcloud.com/tracks/293`, track],
    [`HTTPS://W.SOUNDCLOUD.COM/player/?url=https%3A//api.soundcloud.com/tracks/293`, track],
    [`http://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293`, track],
    [track, track],
  ])('frames %s', (href, want) => {
    expect(src(href)).toBe(want)
  })

  it.each([
    ...impostors(at('https%3A//api.soundcloud.com/tracks/293')),
    at('https%3A//evil.example/tracks/293'),
    at('https%3A//api.soundcloud.com.evil.example/tracks/293'),
    at('https%3A//evil-api.soundcloud.com/tracks/293'),
    at('https%3A//user%40api.soundcloud.com/tracks/293'),
    at('https%3A//api.soundcloud.com%40evil.example/tracks/293'),
    at('https%3A//api.soundcloud.com%3A8443/tracks/293'),
    at('http%3A//api.soundcloud.com/tracks/293'),
    at('javascript%3Aalert(1)'),
    at('data%3Atext/html%2Cx'),
    at('https%3A//api.soundcloud.com/users/293'),
    at('https%3A//api.soundcloud.com/tracks/abc'),
    at('https%3A//api.soundcloud.com/tracks/293/'),
    at('https%3A//api.soundcloud.com/tracks/293%3Fsecret_token%3Ds-x'),
    at('https%3A//api.soundcloud.com/tracks/293%23x'),
    at('https%3A//api.soundcloud.com/tracks/..%252Fusers%252F1'),
    at('https%3A//api.soundcloud.com/tracks/soundcloud%253Aplaylists%253A42'),
    at('https%3A//api.soundcloud.com/tracks/1/../../users/1'),
    `${at('https%3A//evil.example/tracks/1')}&url=https%3A//api.soundcloud.com/tracks/293`,
    'https://w.soundcloud.com/player/',
    'https://w.soundcloud.com/player/x?url=https%3A//api.soundcloud.com/tracks/293',
    'https://w.soundcloud.com/other/?url=https%3A//api.soundcloud.com/tracks/293',
    'https://soundcloud.com/user/track',
    'https://soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293',
    'https://on.soundcloud.com/abc',
  ])('leaves %s a link', (href) => {
    expect(src(href)).toBeNull()
  })
})

describe('Miro', () => {
  const player = 'https://miro.com/app/live-embed/uXjVOabcdEF=/'

  it.each([
    ['https://miro.com/app/board/uXjVOabcdEF=/', player],
    ['https://miro.com/app/board/uXjVOabcdEF=', player],
    ['https://miro.com/app/board/uXjVOabcdEF%3D/', player],
    ['https://miro.com/app/board/uXjVOabcdEF=/?share_link_id=123#x', player],
    ['https://miro.com/app/live-embed/uXjVOabcdEF=/?embedMode=view_only_without_ui', player],
    ['https://miro.com/app/board/o9J_lAbCdEf=/', 'https://miro.com/app/live-embed/o9J_lAbCdEf=/'],
    ['HTTPS://MIRO.COM/app/board/uXjVOabcdEF=/', player],
    ['http://miro.com/app/board/uXjVOabcdEF=/', player],
  ])('frames %s', (href, want) => {
    expect(src(href)).toBe(want)
  })

  it.each([
    ...impostors('https://miro.com/app/board/uXjVOabcdEF=/'),
    'https://www.miro.com/app/board/uXjVOabcdEF=/',
    'https://miro.com/app/board/short/',
    'https://miro.com/app/board/uXjVOabcdEF===/',
    'https://miro.com/app/board/uXjVO.bcdEF=/',
    'https://miro.com/app/board/uXjVOabcdEF%2F/',
    'https://miro.com/app/board/%2e%2e/uXjVOabcdEF=/',
    'https://miro.com/app/board/uXjVOabcdEF=/frame/1',
    'https://miro.com/app/dashboard/',
    'https://miro.com/welcomeonboard/uXjVOabcdEF=/',
  ])('leaves %s a link', (href) => {
    expect(src(href)).toBeNull()
  })
})

describe('frameFor for the providers', () => {
  const players = [
    [
      'https://www.loom.com/embed/0123456789abcdef0123456789abcdef?t=5',
      'loom',
      'Loom video',
      'video',
      `${POPUPS} allow-presentation`,
      'fullscreen; autoplay',
    ],
    [
      'https://embed.figma.com/design/AbCdEfGhIjKlMnOpQrStUv?embed-host=pedit&node-id=1-2',
      'figma',
      'Figma file',
      'doc',
      `${POPUPS} allow-forms`,
      'fullscreen; clipboard-write',
    ],
    [
      'https://codepen.io/some_user-1/embed/AbC123?default-tab=result',
      'codepen',
      'CodePen pen',
      'doc',
      `${POPUPS} allow-forms allow-modals`,
      'fullscreen; clipboard-write',
    ],
    [
      'https://stackblitz.com/edit/vitejs-vite-abc?embed=1&file=src/main.ts',
      'stackblitz',
      'StackBlitz project',
      'doc',
      `${POPUPS} allow-forms allow-modals`,
      'cross-origin-isolated; clipboard-write; fullscreen',
    ],
    [
      'https://stackblitz.com/github/some-org/repo?embed=1',
      'stackblitz',
      'StackBlitz project',
      'doc',
      `${POPUPS} allow-forms allow-modals`,
      'cross-origin-isolated; clipboard-write; fullscreen',
    ],
    [
      'https://observablehq.com/embed/@d3/bar-chart?cells=chart',
      'observable',
      'Observable notebook',
      'doc',
      POPUPS,
      'fullscreen; clipboard-write',
    ],
    [
      'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
      'spotify',
      'Spotify player',
      'audio',
      `${POPUPS} allow-presentation`,
      'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture',
    ],
    [
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F293&auto_play=false',
      'soundcloud',
      'SoundCloud player',
      'audio',
      POPUPS,
      'autoplay',
    ],
    [
      'https://miro.com/app/live-embed/uXjVOabcdEF=/',
      'miro',
      'Miro board',
      'doc',
      `${POPUPS} allow-forms`,
      'fullscreen',
    ],
  ] as const

  it.each(players)('derives %s as %s', (frameSrc, provider, title, shape, sandbox, allow) => {
    expect(frameFor(frameSrc)).toEqual({ src: frameSrc, provider, title, shape, sandbox, allow })
    expect(providerOf(frameSrc)).toBe(provider)
    expect(embedFor(frameSrc)).toEqual({
      kind: 'frame',
      src: frameSrc,
      provider,
      title,
      shape,
      sandbox,
      allow,
    })
  })

  it.each(players)('never lets %s navigate the editor or download', (frameSrc) => {
    const sandbox = frameFor(frameSrc)?.sandbox.split(' ') ?? []
    expect(sandbox).not.toContain('allow-top-navigation')
    expect(sandbox).not.toContain('allow-top-navigation-by-user-activation')
    expect(sandbox).not.toContain('allow-top-navigation-to-custom-protocols')
    expect(sandbox).not.toContain('allow-downloads')
    expect(frameFor(frameSrc)?.allow).not.toContain('clipboard-read')
  })

  it.each([
    [
      'https://www.loom.com/embed/0123456789abcdef0123456789abcdef?sid=x#t',
      'https://www.loom.com/embed/0123456789abcdef0123456789abcdef',
    ],
    [
      'HTTPS://WWW.LOOM.COM/embed/0123456789abcdef0123456789abcdef',
      'https://www.loom.com/embed/0123456789abcdef0123456789abcdef',
    ],
    [
      'https://embed.figma.com/board/AbCdEfGhIjKlMnOpQrStUv/Name?embed-host=evil&x=1',
      'https://embed.figma.com/board/AbCdEfGhIjKlMnOpQrStUv?embed-host=pedit',
    ],
    ['https://codepen.io/u/embed/AbC123/', 'https://codepen.io/u/embed/AbC123?default-tab=result'],
    ['https://stackblitz.com/edit/abc', 'https://stackblitz.com/edit/abc?embed=1'],
    [
      'https://observablehq.com/embed/@d3/x/../bar-chart',
      'https://observablehq.com/embed/@d3/bar-chart',
    ],
    [
      'https://open.spotify.com/embed/show/4uLU6hMCjMI75M1A2tKUQC/?si=1',
      'https://open.spotify.com/embed/show/4uLU6hMCjMI75M1A2tKUQC',
    ],
    [
      'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/playlists/42&show_user=false',
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Fplaylists%2F42&auto_play=false',
    ],
    [
      'https://miro.com/app/live-embed/uXjVOabcdEF%3D',
      'https://miro.com/app/live-embed/uXjVOabcdEF=/',
    ],
  ])('rebuilds %s', (frameSrc, want) => {
    expect(frameFor(frameSrc)?.src).toBe(want)
    expect(frameFor(want)?.src).toBe(want)
  })

  it.each([
    // Links someone shares are not players, though embedFor turns them into one.
    'https://www.loom.com/share/0123456789abcdef0123456789abcdef',
    'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/x',
    'https://embed.figma.com/file/AbCdEfGhIjKlMnOpQrStUv',
    'https://codepen.io/u/pen/AbC123',
    'https://codepen.io/u/full/AbC123',
    'https://codepen.io/',
    'https://codepen.io/login',
    'https://codepen.io/u/embed/AbC123/../../../login',
    'https://observablehq.com/@d3/bar-chart',
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    'https://miro.com/app/board/uXjVOabcdEF=/',
    // Paths under a prefix that name nothing, or leave it.
    'https://www.loom.com/embed/',
    'https://www.loom.com/embed/../share/0123456789abcdef0123456789abcdef',
    'https://www.loom.com/embed/%2e%2e/x',
    'https://embed.figma.com/design/',
    'https://stackblitz.com/edit/a/../../fork/x',
    'https://stackblitz.com/edit/a%2fb',
    'https://open.spotify.com/embed/../track/4uLU6hMCjMI75M1A2tKUQC',
    'https://w.soundcloud.com/player/',
    'https://w.soundcloud.com/player/?url=https%3A//evil.example/tracks/1',
    'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/users/1',
    'https://miro.com/app/live-embed/',
    // http, user-info and ports.
    'http://www.loom.com/embed/0123456789abcdef0123456789abcdef',
    'http://codepen.io/u/embed/AbC123',
    'https://u@open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
    'https://open.spotify.com@evil.example/embed/track/4uLU6hMCjMI75M1A2tKUQC',
    'https://miro.com:8443/app/live-embed/uXjVOabcdEF=/',
    'https://evil-codepen.io/u/embed/AbC123',
    'https://codepen.io.evil.example/u/embed/AbC123',
  ])('refuses %s', (frameSrc) => {
    expect(frameFor(frameSrc)).toBeNull()
    expect(isAllowedFrame(frameSrc)).toBe(false)
  })
})
