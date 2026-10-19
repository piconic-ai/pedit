// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ImageResolver } from '../src/attachments.ts'
import { pageMediaSources, patch, render, sanitize } from '../src/preview.ts'

function html(source: string): string {
  const div = document.createElement('div')
  div.append(render(source))
  return div.innerHTML
}

function dom(source: string, sources?: readonly string[]): HTMLElement {
  const div = document.createElement('div')
  div.append(render(source, undefined, sources))
  return div
}

const PLAYER_ATTRS =
  ' loading="lazy" allow="fullscreen; picture-in-picture; encrypted-media"' +
  ' sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"' +
  ' referrerpolicy="strict-origin-when-cross-origin"'

describe('sanitize', () => {
  it('strips scripts and event handlers', () => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        '<p onclick="alert(1)">hi</p><script>alert(1)</script><img src="https://x.test/a.png" onerror="alert(1)">' +
          '<a href="javascript:alert(1)">x</a><svg onload="alert(1)"></svg><style>*{}</style>',
      ),
    )
    const out = div.innerHTML
    expect(out).not.toMatch(/script|onclick|onerror|onload|javascript:|<style/i)
    expect(div.querySelector('p')?.textContent).toBe('hi')
    // Outside render() no external source is allowed, like the strict policy.
    expect(div.querySelector('img')).toBeNull()
  })

  it('drops external media that no source allows', () => {
    const div = document.createElement('div')
    div.append(
      sanitize('<img src="https://x.test/a.png"><video src="https://x.test/a.mp4"></video>'),
    )
    expect(div.innerHTML).toBe('')
  })

  it('drops iframes that are not a known player', () => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        '<iframe src="https://evil.example/"></iframe>' +
          '<iframe srcdoc="<script>alert(1)</script>"></iframe>' +
          '<iframe src="https://player.vimeo.com/video/1"></iframe>',
      ),
    )
    const frames = [...div.querySelectorAll('iframe')]
    expect(frames.map((f) => f.getAttribute('src'))).toEqual(['https://player.vimeo.com/video/1'])
    expect(frames[0]?.hasAttribute('srcdoc')).toBe(false)
  })

  it("rewrites a player's attributes to pedit's own", () => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        '<iframe src="https://player.vimeo.com/video/1" title="x" sandbox="allow-scripts allow-same-origin allow-top-navigation allow-forms"' +
          ' allow="camera; microphone" referrerpolicy="unsafe-url" loading="eager"></iframe>' +
          '<iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe>',
      ),
    )
    const [vimeo, youtube] = [...div.querySelectorAll('iframe')]
    for (const [frame, title] of [
      [vimeo, 'Vimeo video'],
      [youtube, 'YouTube video'],
    ] as const) {
      expect(frame?.getAttribute('title')).toBe(title)
      expect(frame?.getAttribute('sandbox')).toBe(
        'allow-scripts allow-same-origin allow-popups allow-presentation',
      )
      expect(frame?.getAttribute('allow')).toBe('fullscreen; picture-in-picture; encrypted-media')
      expect(frame?.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin')
      expect(frame?.getAttribute('loading')).toBe('lazy')
    }
  })

  it('drops iframes whose src only looks like a player', () => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        '<iframe src="https://player.vimeo.com/video/../x"></iframe>' +
          '<iframe src="https://player.vimeo.com/video/%2e%2e/x"></iframe>' +
          '<iframe src="https://u@player.vimeo.com/video/1"></iframe>' +
          '<iframe src="http://player.vimeo.com/video/1"></iframe>' +
          '<iframe src="https://player.vimeo.com.evil.example/video/1"></iframe>',
      ),
    )
    expect(div.querySelector('iframe')).toBeNull()
  })

  it('drops frames from sites no provider names', () => {
    const div = document.createElement('div')
    div.append(sanitize('<iframe src="https://embed.example.com/1"></iframe>'))
    expect(div.querySelector('iframe')).toBeNull()
  })

  it('drops media that does not come from an absolute http(s) URL', () => {
    const div = document.createElement('div')
    div.append(sanitize('<img src="data:image/png;base64,AAAA"><video src="clip.mp4"></video>'))
    expect(div.innerHTML).toBe('')
  })
})

describe('render', () => {
  it('renders frontmatter fields and tags separately from the body, preserving source lines', () => {
    const out = dom(
      '---\ncreated: 2026-10-03\ntitle: pedit\ndescription: "ローカルのファイルを共同編集"\ntags: [pedit, e2ee, yjs]\n---\n# pedit',
    )
    expect([...out.querySelectorAll('dt')].map((el) => el.textContent)).toEqual([
      'created',
      'title',
      'description',
      'tags',
    ])
    expect(out.querySelector('dd')?.textContent).toBe('2026-10-03')
    expect([...out.querySelectorAll('.frontmatter-item')].map((el) => el.textContent)).toEqual([
      'pedit',
      'e2ee',
      'yjs',
    ])
    expect(out.querySelector('h1')?.getAttribute('data-line')).toBe('6')
    expect(out.querySelector('.frontmatter')?.getAttribute('data-line')).toBe('0')
    expect(out.querySelector('hr, h2')).toBeNull()
  })

  it('supports CRLF, nested fields, multiline values and YAML end markers', () => {
    const out = dom(
      '\uFEFF---\r\nauthor:\r\n  name: Alice\r\ndescription: |\r\n  first\r\n  second\r\ntags:\r\n  - one\r\n  - two\r\n...\r\n\r\nBody',
    )
    expect(out.querySelector('dl dl dd')?.textContent).toBe('Alice')
    expect(out.textContent).toContain('first\nsecond\n')
    expect(out.querySelectorAll('.frontmatter-item')).toHaveLength(2)
    expect(out.querySelector('p')?.getAttribute('data-line')).toBe('11')
  })

  it('keeps invalid YAML readable and escapes metadata HTML', () => {
    const invalid = dom('---\ntags: [unfinished\n---\n# Body')
    expect(invalid.querySelector('.frontmatter pre')?.textContent).toContain('tags: [unfinished')
    expect(invalid.querySelector('h1')?.textContent).toBe('Body')
    const out = dom('---\n"<img src=x onerror=alert(1)>": "<script>alert(1)</script>"\n---')
    expect(out.querySelector('img, script')).toBeNull()
    expect(out.querySelector('dd')?.textContent).toBe('<script>alert(1)</script>')
  })

  it('only treats a closed header at the document start as frontmatter', () => {
    expect(dom('---\ntitle: unfinished').querySelector('.frontmatter')).toBeNull()
    expect(dom('# Title\n\n---\ntitle: body\n---').querySelector('.frontmatter')).toBeNull()
  })

  it('shows raw HTML in the document as text', () => {
    const out = dom('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>')
    expect(out.querySelector('script, img')).toBeNull()
    expect(out.textContent).toContain('<script>alert(1)</script>')
  })

  it('renders absolute images and falls back to the alt text for relative ones', () => {
    const out = dom('![cat](https://example.com/cat.png) ![dog](images/dog.png) ![](../x.png)', [
      'https:',
    ])
    const img = out.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://example.com/cat.png')
    expect(img?.getAttribute('alt')).toBe('cat')
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(img?.getAttribute('referrerpolicy')).toBe('no-referrer')
    const missing = [...out.querySelectorAll('.missing-image')].map((m) => m.textContent)
    expect(missing).toEqual(['dog', '../x.png'])
  })

  it('shows the images added during the session', () => {
    const url = 'blob:http://localhost/1234'
    const images: ImageResolver = {
      lookup: (src) =>
        src === 'assets/a.png' ? { url } : src === 'assets/b.png' ? 'loading' : null,
      owns: (u) => u === url,
    }
    const div = document.createElement('div')
    div.append(render('![a](assets/a.png) ![b](assets/b.png) ![c](assets/c.png)', images))
    const img = div.querySelector('img')
    expect(img?.getAttribute('src')).toBe(url)
    expect(img?.getAttribute('alt')).toBe('a')
    expect(img?.getAttribute('title')).toBe('assets/a.png')
    expect(div.querySelector('.loading-image')?.textContent).toBe('b')
    expect(div.querySelector('.missing-image')?.textContent).toBe('c')
  })

  it('keeps out blob URLs that are not our images', () => {
    const images: ImageResolver = { lookup: () => null, owns: () => false }
    const div = document.createElement('div')
    div.append(
      render('<img src="blob:http://localhost/x">\n\n![x](blob:http://localhost/y)', images),
    )
    expect(div.querySelector('img')).toBeNull()
    // Without a resolver, nothing is ours.
    expect(dom('![x](blob:http://localhost/y)').querySelector('img')).toBeNull()
  })

  it('plays video files from images and bare URLs', () => {
    const out = dom('![demo](https://example.com/demo.mp4)\n\nhttps://example.com/other.webm', [
      'https:',
    ])
    const videos = [...out.querySelectorAll('video')]
    expect(videos.map((v) => v.getAttribute('src'))).toEqual([
      'https://example.com/demo.mp4',
      'https://example.com/other.webm',
    ])
    expect(videos[0]?.hasAttribute('controls')).toBe(true)
    expect(videos[0]?.getAttribute('aria-label')).toBe('demo')
  })

  describe('under the strict default (no external media)', () => {
    it('shows an external image as a placeholder', () => {
      const out = dom('![cat](https://example.com/cat.png)')
      expect(out.querySelector('img')).toBeNull()
      const blocked = out.querySelector('.blocked-media.blocked-image')
      expect(blocked?.textContent).toBe('cat: this relay does not load external images')
      expect(blocked?.getAttribute('title')).toBe('https://example.com/cat.png')
    })

    it('shows an external video as a placeholder', () => {
      const out = dom('![demo](https://example.com/demo.mp4)')
      expect(out.querySelector('video')).toBeNull()
      expect(out.querySelector('.blocked-video')?.textContent).toBe(
        'demo: this relay does not load external videos',
      )
    })

    it('leaves a bare video URL as a link', () => {
      const out = dom('https://example.com/other.webm')
      expect(out.querySelector('video')).toBeNull()
      expect(out.querySelector('a')?.getAttribute('target')).toBe('_blank')
    })

    it('still shows players and pasted images', () => {
      expect(
        dom('https://www.youtube.com/watch?v=dQw4w9WgXcQ').querySelector('iframe'),
      ).not.toBeNull()
      const url = 'blob:http://localhost/1234'
      const div = document.createElement('div')
      div.append(render('![a](assets/a.png)', { lookup: () => ({ url }), owns: (u) => u === url }))
      expect(div.querySelector('img')?.getAttribute('src')).toBe(url)
    })
  })

  it('loads only what the allowed sources match', () => {
    const out = dom(
      '![a](https://img.example.com/pics/a.png) ![b](https://img.example.com/other.png) ![c](http://192.168.1.1/x.png)',
      ['https://img.example.com/pics/'],
    )
    expect([...out.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([
      'https://img.example.com/pics/a.png',
    ])
    expect(out.querySelectorAll('.blocked-image')).toHaveLength(2)
  })

  it('embeds bare YouTube and Vimeo URLs', () => {
    const out = dom(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n<https://vimeo.com/76979871>\n\n- https://youtu.be/dQw4w9WgXcQ',
    )
    const frames = [...out.querySelectorAll('.embed iframe')]
    expect(frames.map((f) => f.getAttribute('src'))).toEqual([
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://player.vimeo.com/video/76979871',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ])
    expect(frames[0]?.getAttribute('sandbox')).toContain('allow-scripts')
    expect(out.querySelector('p')).toBeNull()
  })

  it('renders the YouTube and Vimeo players as before', () => {
    expect(html('https://youtu.be/dQw4w9WgXcQ?t=90\n\nhttps://vimeo.com/76979871/abc123')).toBe(
      '<div class="embed" data-line="0"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90" title="YouTube video"' +
        `${PLAYER_ATTRS}></iframe></div>` +
        '<div class="embed" data-line="2"><iframe src="https://player.vimeo.com/video/76979871?h=abc123" title="Vimeo video"' +
        `${PLAYER_ATTRS}></iframe></div>`,
    )
  })

  it.each(['https://player.vimeo.com/video/abc/xyz', 'https://www.youtube-nocookie.com/embed/'])(
    'keeps player URL %s that names no video a link',
    (href) => {
      const out = dom(href, [])
      expect(out.querySelector('iframe')).toBeNull()
      expect(out.querySelector('a')?.getAttribute('href')).toBe(href)
    },
  )

  it('keeps a URL no provider takes a link', () => {
    const out = dom('https://embed.example.com/v/1')
    expect(out.querySelector('iframe')).toBeNull()
    expect(out.querySelector('a')?.getAttribute('href')).toBe('https://embed.example.com/v/1')
  })

  it('keeps video URLs inside a sentence or with link text as links', () => {
    const out = dom(
      'Watch https://youtu.be/dQw4w9WgXcQ now\n\n[the talk](https://youtu.be/dQw4w9WgXcQ)',
    )
    expect(out.querySelector('iframe')).toBeNull()
    expect(out.querySelectorAll('a[href]')).toHaveLength(2)
  })

  it('opens absolute links in a new tab and disarms the rest', () => {
    const out = dom(
      '[web](https://example.com) [mail](mailto:a@example.com) [file](other.md) [top](#top) [js](javascript:alert(1))',
    )
    const links = [...out.querySelectorAll('a')]
    expect(
      links.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]),
    ).toEqual([
      ['web', 'https://example.com', '_blank'],
      ['mail', 'mailto:a@example.com', '_blank'],
      ['file', null, null],
      ['top', null, null],
    ])
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(out.textContent).toContain('[js](javascript:alert(1))')
  })

  it('tags blocks with their source line', () => {
    const out = dom(
      '# Title\n\ntext\n\n- a\n- b\n\n```\ncode\n```\n\nhttps://youtu.be/dQw4w9WgXcQ\n',
    )
    const lines = [...out.querySelectorAll('[data-line]')].map((el) => [
      el.tagName,
      el.getAttribute('data-line'),
    ])
    expect(lines).toEqual([
      ['H1', '0'],
      ['P', '2'],
      ['UL', '4'],
      ['LI', '4'],
      ['LI', '5'],
      ['CODE', '7'],
      ['DIV', '11'],
    ])
  })
})

describe('patch', () => {
  it('keeps unchanged blocks in place and updates their lines', () => {
    const container = document.createElement('div')
    patch(container, render('# A\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nold\n\nend\n'))
    const [title, embed] = [container.querySelector('h1'), container.querySelector('.embed')]
    const end = container.lastElementChild

    patch(container, render('# A\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nnew\nlines\n\nend\n'))
    expect(container.querySelector('h1')).toBe(title)
    expect(container.querySelector('.embed')).toBe(embed)
    expect(container.lastElementChild).toBe(end)
    expect(end?.getAttribute('data-line')).toBe('7')
    expect(container.textContent).toContain('new\nlines')
    expect(container.textContent).not.toContain('old')
    expect(html('# A\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nnew\nlines\n\nend\n')).toBe(
      container.innerHTML,
    )
  })

  it('handles inserting at the start and removing everything', () => {
    const container = document.createElement('div')
    patch(container, render('a\n\nb\n'))
    const b = container.lastElementChild
    patch(container, render('z\n\na\n\nb\n'))
    expect(container.lastElementChild).toBe(b)
    expect(container.innerHTML).toBe(html('z\n\na\n\nb\n'))
    patch(container, render(''))
    expect(container.innerHTML).toBe('')
  })
})

describe('pageMediaSources', () => {
  const page = (head: string) =>
    new DOMParser().parseFromString(`<head>${head}</head>`, 'text/html')

  it('reads the list the Worker wrote into the page', () => {
    expect(pageMediaSources(page('<meta name="pedit-media-sources" content="https:">'))).toEqual([
      'https:',
    ])
  })

  it('allows nothing without the tag or with a bad value', () => {
    expect(pageMediaSources(page(''))).toEqual([])
    expect(
      pageMediaSources(page('<meta name="pedit-media-sources" content="\'unsafe-inline\'">')),
    ).toEqual([])
  })
})
