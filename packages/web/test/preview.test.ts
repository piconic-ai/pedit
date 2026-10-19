// @vitest-environment jsdom

import { PROVIDERS, type ProviderId } from '@pedit/protocol/csp'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import * as Y from 'yjs'
import { ALWAYS_LOAD_KEY, AlwaysLoad } from '../src/alwaysload.ts'
import type { ImageResolver } from '../src/attachments.ts'
import { MAX_REMEMBERED_SNIPPETS, PreviewPane } from '../src/pane.ts'
import * as preview from '../src/preview.ts'
import {
  embedProvider,
  loadEmbed,
  loadSnippet,
  pageMediaSources,
  patch,
  render,
  sanitize,
  toggleRemember,
} from '../src/preview.ts'

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

const PLAYER_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-presentation'
const PLAYER_ALLOW = 'fullscreen; picture-in-picture; encrypted-media'

function placeholder(
  line: number,
  src: string,
  title: string,
  href: string,
  style = '--embed-rw:16;--embed-rh:9',
): string {
  return (
    `<div class="embed" data-line="${line}" data-embed-src="${src}" style="${style}">` +
    `<span class="embed-provider">${title}</span>` +
    `<span class="embed-actions">` +
    `<span class="embed-load" role="button" tabindex="0">Load from ${new URL(src).host}</span>` +
    `<span class="embed-remember" role="checkbox" aria-checked="false" tabindex="0">Always load ${title}</span></span>` +
    `<a class="embed-link" href="${href}" target="_blank" rel="noopener noreferrer">${href}</a></div>`
  )
}

const srcs = (out: Element) =>
  [...out.querySelectorAll('[data-embed-src]')].map((el) => el.getAttribute('data-embed-src'))

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

  it('drops every iframe, even a known player', () => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        '<iframe src="https://evil.example/"></iframe>' +
          '<iframe srcdoc="<script>alert(1)</script>"></iframe>' +
          '<iframe src="https://player.vimeo.com/video/1" sandbox="allow-scripts"></iframe>' +
          '<div class="embed"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></iframe></div>',
      ),
    )
    expect(div.querySelector('iframe')).toBeNull()
  })

  it('keeps embed placeholders for a known player', () => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        '<div class="embed" data-embed-src="https://player.vimeo.com/video/1" style="--embed-rw:16;--embed-rh:9">' +
          '<span class="embed-load" role="button" tabindex="0">Load from player.vimeo.com</span></div>',
      ),
    )
    const load = div.querySelector('[data-embed-src] .embed-load')
    expect(load?.getAttribute('role')).toBe('button')
    expect(load?.getAttribute('tabindex')).toBe('0')
  })

  it.each([
    '--embed-rw:16;--embed-rh:9',
    '--embed-w:560;--embed-rw:560;--embed-rh:315',
    '--embed-h:152',
  ])("keeps a placeholder's box %s", (style) => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        `<div class="embed" data-embed-src="https://player.vimeo.com/video/1" style="${style}"></div>`,
      ),
    )
    expect(div.querySelector('[data-embed-src]')?.getAttribute('style')).toBe(style)
  })

  it.each([
    'color:red',
    '--embed-rw:16;--embed-rh:9;color:red',
    '--embed-rw:16;--embed-rh:9;background:url(https://evil.example/)',
    '--embed-w:560',
    '--embed-h:99999',
    '--embed-rw:100;--embed-rh:1',
  ])("drops a placeholder's style %j that is no box", (style) => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        `<div class="embed" data-embed-src="https://player.vimeo.com/video/1" style="${style}"></div>`,
      ),
    )
    const el = div.querySelector('[data-embed-src]')
    expect(el).not.toBeNull()
    expect(el?.hasAttribute('style')).toBe(false)
  })

  it.each([
    'https://evil.example/',
    'https://player.vimeo.com/video/../x',
    'https://player.vimeo.com/video/%2e%2e/x',
    'https://u@player.vimeo.com/video/1',
    'http://player.vimeo.com/video/1',
    'https://player.vimeo.com.evil.example/video/1',
    'javascript:alert(1)',
    '',
  ])('drops a placeholder whose src %s is not a frame pedit allows', (src) => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        `<p>before</p><div class="embed" data-embed-src="${src}"><span class="embed-load">Load</span></div>`,
      ),
    )
    expect(div.innerHTML).toBe('<p>before</p>')
  })

  it('drops placeholders for sites no provider names', () => {
    const div = document.createElement('div')
    div.append(sanitize('<div class="embed" data-embed-src="https://embed.example.com/1"></div>'))
    expect(div.innerHTML).toBe('')
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

    it('still offers players and shows pasted images', () => {
      expect(srcs(dom('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))).toEqual([
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      ])
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

  it('offers bare YouTube and Vimeo URLs as placeholders', () => {
    const out = dom(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n\n<https://vimeo.com/76979871>\n\n- https://youtu.be/dQw4w9WgXcQ',
    )
    expect(srcs(out)).toEqual([
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://player.vimeo.com/video/76979871',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ])
    expect(out.querySelector('iframe')).toBeNull()
    expect(out.querySelector('p')).toBeNull()
  })

  it('names the provider and the host it would load from, and links the URL', () => {
    expect(html('https://youtu.be/dQw4w9WgXcQ?t=90\n\nhttps://vimeo.com/76979871/abc123')).toBe(
      placeholder(
        0,
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90',
        'YouTube',
        'https://youtu.be/dQw4w9WgXcQ?t=90',
      ) +
        placeholder(
          2,
          'https://player.vimeo.com/video/76979871?h=abc123',
          'Vimeo',
          'https://vimeo.com/76979871/abc123',
        ),
    )
  })

  it('sizes a placeholder by the hint after its URL, which the frame never gets', () => {
    const href = 'https://youtu.be/dQw4w9WgXcQ?t=90#height=300&width=400'
    expect(html(href)).toBe(
      placeholder(
        0,
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90',
        'YouTube',
        href.replaceAll('&', '&amp;'),
        '--embed-w:400;--embed-rw:400;--embed-rh:300',
      ),
    )
    const full = dom('https://vimeo.com/76979871#width=100%&height=480')
    expect(full.querySelector('[data-embed-src]')?.getAttribute('style')).toBe('--embed-h:480')
  })

  it("gives a placeholder its provider's box for the URL", () => {
    const out = dom('https://www.youtube.com/shorts/dQw4w9WgXcQ\n\nhttps://vimeo.com/76979871')
    expect(
      [...out.querySelectorAll('[data-embed-src]')].map((el) => el.getAttribute('style')),
    ).toEqual(['--embed-rw:9;--embed-rh:16', '--embed-rw:16;--embed-rh:9'])
  })

  it.each([
    'https://youtu.be/dQw4w9WgXcQ#width=560;color:red',
    'https://youtu.be/dQw4w9WgXcQ#width=560&height=315;color:red',
    'https://youtu.be/dQw4w9WgXcQ#width=560%22%20onclick=%22alert(1)',
    'https://youtu.be/dQw4w9WgXcQ#width=560&height=315&style=color:red',
  ])('ignores a fragment %s that is not a hint', (href) => {
    const el = dom(href).querySelector('[data-embed-src]')
    expect(el?.getAttribute('style')).toBe('--embed-rw:16;--embed-rh:9')
    expect(el?.getAttribute('data-embed-src')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    )
    expect(el?.hasAttribute('onclick')).toBe(false)
  })

  it('renders no iframe for any provider', () => {
    const source = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://vimeo.com/76979871',
      'https://player.vimeo.com/video/76979871',
    ].join('\n\n')
    const out = dom(source, [])
    expect(out.querySelectorAll('[data-embed-src]')).toHaveLength(5)
    expect(out.innerHTML).not.toContain('<iframe')
  })

  it.each(['https://player.vimeo.com/video/abc/xyz', 'https://www.youtube-nocookie.com/embed/'])(
    'keeps player URL %s that names no video a link',
    (href) => {
      const out = dom(href, [])
      expect(out.querySelector('[data-embed-src]')).toBeNull()
      expect(out.querySelector('a')?.getAttribute('href')).toBe(href)
    },
  )

  it('keeps a URL no provider takes a link', () => {
    const out = dom('https://embed.example.com/v/1')
    expect(out.querySelector('[data-embed-src]')).toBeNull()
    expect(out.querySelector('a')?.getAttribute('href')).toBe('https://embed.example.com/v/1')
  })

  it('keeps video URLs inside a sentence or with link text as links', () => {
    const out = dom(
      'Watch https://youtu.be/dQw4w9WgXcQ now\n\n[the talk](https://youtu.be/dQw4w9WgXcQ)\n\n[https://vimeo.com/76979871](https://vimeo.com/76979871)',
    )
    expect(out.querySelector('[data-embed-src]')).toBeNull()
    expect(out.querySelectorAll('a[href]')).toHaveLength(3)
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

describe('loadEmbed', () => {
  function mounted(source: string): HTMLElement {
    const div = document.createElement('div')
    document.body.append(div)
    patch(div, render(source, undefined, []))
    return div
  }

  it.each([
    [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'YouTube',
    ],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871', 'Vimeo'],
  ])('loads the player for %s with only its own attributes', (url, src, title) => {
    const div = mounted(url)
    const placeholder = div.querySelector('[data-embed-src]') as Element
    const frame = loadEmbed(placeholder)
    expect(frame).toBe(div.querySelector('iframe'))
    expect(placeholder.children).toHaveLength(1)
    expect(placeholder.classList.contains('embed--loaded')).toBe(true)
    expect(
      Object.fromEntries([...(frame?.attributes ?? [])].map((a) => [a.name, a.value])),
    ).toEqual({
      src,
      title,
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-presentation',
      allow: 'fullscreen; picture-in-picture; encrypted-media',
      referrerpolicy: 'strict-origin-when-cross-origin',
    })
    expect(document.activeElement).toBe(frame)
    div.remove()
  })

  it('loads only frames the preview rendered', () => {
    const div = document.createElement('div')
    div.innerHTML =
      '<div class="embed" data-embed-src="https://www.youtube-nocookie.com/embed/aaaaaaaaaaa"></div>'
    expect(loadEmbed(div.firstElementChild as Element)).toBeNull()
    expect(div.querySelector('iframe')).toBeNull()
  })

  it('keeps the box when the player loads, and loads without the hint', () => {
    const div = mounted('https://vimeo.com/76979871#width=640&height=360')
    const placeholder = div.querySelector('[data-embed-src]') as HTMLElement
    const style = placeholder.getAttribute('style')
    expect(style).toBe('--embed-w:640;--embed-rw:640;--embed-rh:360')
    const frame = loadEmbed(placeholder)
    expect(frame?.parentElement).toBe(placeholder)
    expect(div.querySelector('.embed')).toBe(placeholder)
    expect(placeholder.getAttribute('style')).toBe(style)
    expect(frame?.getAttribute('src')).toBe('https://player.vimeo.com/video/76979871')
    expect(frame?.hasAttribute('style')).toBe(false)
    div.remove()
  })

  it('takes nothing but the src from the placeholder', () => {
    const div = mounted('https://vimeo.com/76979871')
    const placeholder = div.querySelector('[data-embed-src]') as Element
    placeholder.setAttribute('data-embed-sandbox', 'allow-top-navigation')
    placeholder.setAttribute('data-title', 'x')
    const frame = loadEmbed(placeholder)
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-top-navigation')
    expect(frame?.title).toBe('Vimeo')
    div.remove()
  })

  it.each([
    'https://evil.example/',
    'https://player.vimeo.com/video/../x',
    'http://player.vimeo.com/video/1',
    'https://embed.example.com/v/1',
  ])('refuses a placeholder whose src was changed to %s', (src) => {
    const div = mounted('https://vimeo.com/76979871')
    const placeholder = div.querySelector('[data-embed-src]') as Element
    placeholder.setAttribute('data-embed-src', src)
    expect(loadEmbed(placeholder)).toBeNull()
    expect(div.querySelector('iframe')).toBeNull()
    expect(placeholder.querySelector('.embed-load')).not.toBeNull()
    div.remove()
  })

  describe('from the preview pane', () => {
    async function pane(source: string) {
      const text = new Y.Doc().getText('content')
      const p = new PreviewPane(text, { load: () => Promise.resolve(preview) })
      document.body.append(p.element)
      text.insert(0, source)
      p.active = true
      await vi.waitFor(() => expect(p.element.querySelector('.embed-load')).not.toBeNull())
      return p.element
    }

    it('loads the player on click', async () => {
      const element = await pane('# Video\n\nhttps://youtu.be/dQw4w9WgXcQ')
      ;(element.querySelector('.embed-load') as HTMLElement).click()
      expect(element.querySelector('iframe')?.getAttribute('src')).toBe(
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      )
      element.remove()
    })

    it.each(['Enter', ' '])('loads the player with the %j key', async (key) => {
      const element = await pane('https://vimeo.com/76979871')
      const control = element.querySelector('.embed-load') as HTMLElement
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      control.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(element.querySelector('iframe')?.getAttribute('src')).toBe(
        'https://player.vimeo.com/video/76979871',
      )
      element.remove()
    })

    it('ignores other keys and clicks elsewhere', async () => {
      const element = await pane('https://vimeo.com/76979871')
      const control = element.querySelector('.embed-load') as HTMLElement
      control.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
      ;(element.querySelector('.embed-provider') as HTMLElement).click()
      expect(element.querySelector('iframe')).toBeNull()
      element.remove()
    })

    it('refuses a placeholder whose src was changed', async () => {
      const element = await pane('https://vimeo.com/76979871')
      element
        .querySelector('[data-embed-src]')
        ?.setAttribute('data-embed-src', 'https://evil.example/')
      ;(element.querySelector('.embed-load') as HTMLElement).click()
      expect(element.querySelector('iframe')).toBeNull()
      element.remove()
    })
  })
})

describe('provider embeds', () => {
  // A link someone shares, the player it becomes, its provider and its box.
  const cases = [
    [
      'https://www.loom.com/share/0123456789abcdef0123456789abcdef?sid=x',
      'https://www.loom.com/embed/0123456789abcdef0123456789abcdef',
      'loom',
      '--embed-rw:16;--embed-rh:9',
    ],
    [
      'https://www.figma.com/design/AbCdEfGhIjKlMnOpQrStUv/File?node-id=1-2&t=x',
      'https://embed.figma.com/design/AbCdEfGhIjKlMnOpQrStUv?embed-host=pedit&node-id=1-2',
      'figma',
      '--embed-rw:4;--embed-rh:3',
    ],
    [
      'https://codepen.io/u/pen/AbC123',
      'https://codepen.io/u/embed/AbC123?default-tab=result',
      'codepen',
      '--embed-rw:4;--embed-rh:3',
    ],
    [
      'https://stackblitz.com/edit/vitejs-vite-abc?file=src/main.ts',
      'https://stackblitz.com/edit/vitejs-vite-abc?embed=1&file=src/main.ts',
      'stackblitz',
      '--embed-rw:4;--embed-rh:3',
    ],
    [
      'https://observablehq.com/@d3/bar-chart',
      'https://observablehq.com/embed/@d3/bar-chart',
      'observable',
      '--embed-rw:4;--embed-rh:3',
    ],
    [
      'https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=x',
      'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
      'spotify',
      '--embed-h:152',
    ],
    [
      'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&auto_play=true',
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F293&auto_play=false',
      'soundcloud',
      '--embed-h:166',
    ],
    [
      'https://miro.com/app/board/uXjVOabcdEF=/?share_link_id=1',
      'https://miro.com/app/live-embed/uXjVOabcdEF=/',
      'miro',
      '--embed-rw:4;--embed-rh:3',
    ],
  ] as const

  it.each(cases)('offers %s as a placeholder for its player', (href, src, id, style) => {
    const out = dom(href)
    const el = out.querySelector('[data-embed-src]') as Element
    const name = PROVIDERS[id].name
    expect(el.getAttribute('data-embed-src')).toBe(src)
    expect(el.getAttribute('style')).toBe(style)
    expect(el.querySelector('.embed-provider')?.textContent).toBe(name)
    expect(el.querySelector('.embed-load')?.textContent).toBe(`Load from ${new URL(src).host}`)
    expect(el.querySelector('.embed-remember')?.textContent).toBe(`Always load ${name}`)
    expect(el.querySelector('.embed-link')?.getAttribute('href')).toBe(href)
    expect(out.querySelector('iframe')).toBeNull()
  })

  it('renders no iframe for any of them before someone asks', () => {
    const out = dom(cases.map(([href]) => href).join('\n\n'))
    expect(out.querySelectorAll('[data-embed-src]')).toHaveLength(cases.length)
    expect(out.innerHTML).not.toContain('<iframe')
  })

  it.each(cases)('loads %s with only its own attributes', (href, src, id) => {
    const div = document.createElement('div')
    document.body.append(div)
    patch(div, render(href, undefined, []))
    const el = div.querySelector('[data-embed-src]') as Element
    expect(embedProvider(el)).toBe(id)
    const frame = loadEmbed(el)
    const p = PROVIDERS[id]
    expect(
      Object.fromEntries([...(frame?.attributes ?? [])].map((a) => [a.name, a.value])),
    ).toEqual({
      src,
      title: p.name,
      sandbox: ['allow-scripts allow-same-origin allow-popups', ...(p.sandbox ?? [])].join(' '),
      allow: (p.allow ?? []).join('; '),
      referrerpolicy: 'strict-origin-when-cross-origin',
    })
    div.remove()
  })

  it('keeps a look-alike or a SoundCloud player for another site a link', () => {
    const out = dom(
      [
        'https://codepen.io.evil.example/u/pen/AbC123',
        'https://w.soundcloud.com/player/?url=https%3A//evil.example/tracks/293',
        'https://www.figma.com@evil.example/design/AbCdEfGhIjKlMnOpQrStUv',
      ].join('\n\n'),
    )
    expect(out.querySelector('[data-embed-src]')).toBeNull()
    expect(out.querySelectorAll('a[href]')).toHaveLength(3)
  })

  it('drops a placeholder whose src no provider would build, such as a CodePen page', () => {
    for (const src of [
      'https://codepen.io/login',
      'https://w.soundcloud.com/player/?url=https%3A//evil.example/1',
    ]) {
      expect(
        sanitize(`<div class="embed" data-embed-src="${src}">x</div>`).childNodes,
      ).toHaveLength(0)
    }
  })
})

describe('always load', () => {
  function memory(initial: string[] = []) {
    const data = new Map<string, string>([[ALWAYS_LOAD_KEY, JSON.stringify(initial)]])
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v)
      },
    }
  }

  const loaded = (element: Element) =>
    [...element.querySelectorAll('iframe')].map((f) => f.getAttribute('src'))

  async function pane(source: string, always: AlwaysLoad) {
    const text = new Y.Doc().getText('content')
    const p = new PreviewPane(text, { load: () => Promise.resolve(preview), alwaysLoad: always })
    document.body.append(p.element)
    text.insert(0, source)
    p.active = true
    await vi.waitFor(() => expect(p.element.querySelector('[data-embed-src]')).not.toBeNull())
    return { element: p.element, text }
  }

  it('offers to always load the provider of each placeholder, by its name in the registry', () => {
    const out = dom('https://youtu.be/dQw4w9WgXcQ\n\nhttps://vimeo.com/1')
    const boxes = [...out.querySelectorAll('.embed-remember')]
    expect(boxes.map((b) => b.textContent)).toEqual([
      `Always load ${PROVIDERS.youtube.name}`,
      `Always load ${PROVIDERS.vimeo.name}`,
    ])
    for (const b of boxes) {
      expect(b.getAttribute('role')).toBe('checkbox')
      expect(b.getAttribute('aria-checked')).toBe('false')
      expect(b.getAttribute('tabindex')).toBe('0')
    }
  })

  it('offers it for a player of every registered provider', () => {
    // A URL each provider pedit ships frames, of those this relay registers.
    const samples: Record<string, string> = {
      youtube: 'https://youtu.be/dQw4w9WgXcQ',
      vimeo: 'https://vimeo.com/76979871',
      loom: 'https://www.loom.com/share/0123456789abcdef0123456789abcdef',
      figma: 'https://www.figma.com/board/AbCdEfGhIjKlMnOpQrStUv',
      codepen: 'https://codepen.io/u/pen/AbC123',
      stackblitz: 'https://stackblitz.com/github/user/repo',
      observable: 'https://observablehq.com/@d3/bar-chart',
      spotify: 'https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC',
      soundcloud:
        'https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/playlists/soundcloud%3Aplaylists%3A7',
      miro: 'https://miro.com/app/board/o9J_abcdefgh/',
      github: 'https://github.com/o/r/blob/main/README.md',
    }
    for (const [id, url] of Object.entries(samples).filter(([id]) => id in PROVIDERS)) {
      const out = dom(url)
      expect(embedProvider(out.querySelector('[data-embed-src]') as Element)).toBe(id)
      expect(out.querySelector('.embed-remember')?.textContent).toBe(
        `Always load ${PROVIDERS[id as ProviderId].name}`,
      )
    }
  })

  it('names the provider of a placeholder from its src alone, by its registry key', () => {
    const out = dom('https://youtu.be/dQw4w9WgXcQ\n\nhttps://vimeo.com/1')
    const [youtube, vimeo] = [...out.querySelectorAll('[data-embed-src]')] as Element[]
    expect(embedProvider(youtube as Element)).toBe('youtube')
    expect(embedProvider(vimeo as Element)).toBe('vimeo')
    vimeo?.setAttribute('data-embed-src', 'https://evil.example/')
    expect(embedProvider(vimeo as Element)).toBeNull()
    vimeo?.removeAttribute('data-embed-src')
    expect(embedProvider(vimeo as Element)).toBeNull()
  })

  it('loads a remembered provider after rendering, leaving focus where it is', async () => {
    const before = document.activeElement
    const { element } = await pane(
      '# Videos\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nhttps://vimeo.com/76979871',
      new AlwaysLoad(memory(['youtube'])),
    )
    await vi.waitFor(() => expect(element.querySelector('iframe')).not.toBeNull())
    expect(loaded(element)).toEqual(['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'])
    expect(element.querySelector('.embed--loaded iframe')?.getAttribute('sandbox')).toBe(
      PLAYER_SANDBOX,
    )
    // The provider nobody chose stays a placeholder.
    expect(element.querySelectorAll('[data-embed-src]:not(.embed--loaded)')).toHaveLength(1)
    expect(document.activeElement).toBe(before)
    element.remove()
  })

  it('loads a remembered provider added by a later edit', async () => {
    const { element, text } = await pane(
      'https://vimeo.com/76979871',
      new AlwaysLoad(memory(['youtube'])),
    )
    expect(element.querySelector('iframe')).toBeNull()
    text.insert(text.length, '\n\n- https://youtu.be/dQw4w9WgXcQ\n')
    await vi.waitFor(() => expect(loaded(element)).toHaveLength(1))
    expect(loaded(element)).toEqual(['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'])
    const frame = element.querySelector('iframe')
    text.insert(0, 'Above\n\n')
    await vi.waitFor(() => expect(element.querySelector('p')?.textContent).toBe('Above'))
    expect(element.querySelector('iframe')).toBe(frame)
    element.remove()
  })

  it('loads nothing without a remembered provider', async () => {
    const storage = memory()
    const { element, text } = await pane('https://youtu.be/dQw4w9WgXcQ', new AlwaysLoad(storage))
    text.insert(text.length, '\n\nhttps://vimeo.com/76979871')
    await vi.waitFor(() => expect(element.querySelectorAll('[data-embed-src]')).toHaveLength(2))
    expect(element.querySelector('iframe')).toBeNull()
    // Loading without ticking the box remembers nothing.
    ;(element.querySelector('.embed-load') as HTMLElement).click()
    expect(loaded(element)).toHaveLength(1)
    expect(storage.data.get(ALWAYS_LOAD_KEY)).toBe('[]')
    element.remove()
  })

  it('ticks the box by click, Enter or Space, and keeps it ticked through edits elsewhere', async () => {
    const { element, text } = await pane('https://vimeo.com/76979871', new AlwaysLoad(memory()))
    const box = () => element.querySelector('.embed-remember') as HTMLElement
    box().click()
    expect(box().getAttribute('aria-checked')).toBe('true')
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      box().dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(box().getAttribute('aria-checked')).toBe('true')
    expect(element.querySelector('iframe')).toBeNull()
    const ticked = box()
    text.insert(0, 'Above\n\n')
    await vi.waitFor(() => expect(element.querySelector('p')?.textContent).toBe('Above'))
    expect(box()).toBe(ticked)
    expect(box().getAttribute('aria-checked')).toBe('true')
    element.remove()
  })

  it('remembers only the provider when loading with the box ticked, and loads its other players', async () => {
    const storage = memory()
    const always = new AlwaysLoad(storage)
    const { element } = await pane(
      'https://youtu.be/dQw4w9WgXcQ?t=5\n\nhttps://vimeo.com/76979871\n\nhttps://youtu.be/aaaaaaaaaaa',
      always,
    )
    const first = element.querySelector('[data-embed-src]') as Element
    ;(first.querySelector('.embed-remember') as HTMLElement).click()
    ;(first.querySelector('.embed-load') as HTMLElement).click()
    expect(always.ids.get()).toEqual(['youtube'])
    expect(storage.data.get(ALWAYS_LOAD_KEY)).toBe('["youtube"]')
    // Nothing about the URL, the room or its key: the only entry is the provider id.
    expect([...storage.data]).toEqual([[ALWAYS_LOAD_KEY, '["youtube"]']])
    expect(loaded(element)).toEqual([
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=5',
      'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa',
    ])
    // Focus goes to the player that was clicked, not the one loaded with it.
    expect(document.activeElement).toBe(first.querySelector('iframe'))
    element.remove()
  })

  it('still loads only what pedit frames for a remembered provider', async () => {
    const always = new AlwaysLoad(memory())
    const { element } = await pane('https://vimeo.com/76979871', always)
    element
      .querySelector('[data-embed-src]')
      ?.setAttribute('data-embed-src', 'https://evil.example/')
    always.remember('vimeo')
    always.remember('custom:https://evil.example' as never)
    expect(element.querySelector('iframe')).toBeNull()
    element.remove()
  })

  it('remembers nothing when loading with the box ticked is refused', async () => {
    const storage = memory()
    const always = new AlwaysLoad(storage)
    const { element } = await pane('https://vimeo.com/76979871', always)
    // A src pedit frames for Vimeo, but not one this preview rendered.
    const placeholder = element.querySelector('[data-embed-src]') as Element
    placeholder.setAttribute('data-embed-src', 'https://player.vimeo.com/video/999')
    ;(placeholder.querySelector('.embed-remember') as HTMLElement).click()
    ;(placeholder.querySelector('.embed-load') as HTMLElement).click()
    expect(element.querySelector('iframe')).toBeNull()
    expect(always.ids.get()).toEqual([])
    expect(storage.data.get(ALWAYS_LOAD_KEY)).toBe('[]')
    element.remove()
  })

  it('keeps players loaded when their provider is forgotten, and asks again for new ones', async () => {
    const always = new AlwaysLoad(memory(['vimeo']))
    const { element, text } = await pane('https://vimeo.com/76979871', always)
    await vi.waitFor(() => expect(element.querySelector('iframe')).not.toBeNull())
    const frame = element.querySelector('iframe')
    always.forget('vimeo')
    text.insert(text.length, '\n\nhttps://vimeo.com/1')
    await vi.waitFor(() => expect(element.querySelectorAll('[data-embed-src]')).toHaveLength(2))
    expect(element.querySelector('iframe')).toBe(frame)
    expect(loaded(element)).toHaveLength(1)
    element.remove()
  })
})

describe('patch', () => {
  it('keeps a loaded player while someone types elsewhere, not once its URL changes', () => {
    const container = document.createElement('div')
    patch(container, render('# A\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nold\n'))
    const frame = loadEmbed(container.querySelector('[data-embed-src]') as Element)
    expect(frame).not.toBeNull()

    patch(container, render('# A, edited\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nnew\n'))
    expect(container.querySelector('iframe')).toBe(frame)
    expect(container.textContent).toContain('new')

    patch(container, render('# A, edited\n\nhttps://youtu.be/dQw4w9WgXcQ?t=5\n\nnew\n'))
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[data-embed-src]')?.getAttribute('data-embed-src')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=5',
    )
  })

  it('keeps a loaded player when a block is added above it and another changes below', () => {
    const container = document.createElement('div')
    patch(container, render('a\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nb\n'))
    const frame = loadEmbed(container.querySelector('[data-embed-src]') as Element)
    expect(frame).not.toBeNull()

    patch(container, render('a\n\nnew\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nB\n'))
    expect(container.querySelector('iframe')).toBe(frame)
    expect(container.textContent).toContain('new')
    expect(container.textContent).toContain('B')

    patch(container, render('x y\n\nnew\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nB\n'))
    patch(container, render('x\n\ny\n\nnew\n\nhttps://youtu.be/dQw4w9WgXcQ\n\nb\n'))
    expect(container.querySelector('iframe')).toBe(frame)
    expect(container.querySelector('.embed')?.getAttribute('data-line')).toBe('6')
  })

  it('keeps a sized player while someone types elsewhere, not once its size changes', () => {
    const container = document.createElement('div')
    const url = 'https://youtu.be/dQw4w9WgXcQ#width=400'
    patch(container, render(`a\n\n${url}\n\nb\n`))
    const frame = loadEmbed(container.querySelector('[data-embed-src]') as Element)
    expect(frame).not.toBeNull()

    patch(container, render(`a\n\nnew\n\n${url}\n\nB\n`))
    expect(container.querySelector('iframe')).toBe(frame)
    expect(container.querySelector('.embed')?.getAttribute('style')).toBe(
      '--embed-w:400;--embed-rw:400;--embed-rh:225',
    )

    patch(container, render('a\n\nnew\n\nhttps://youtu.be/dQw4w9WgXcQ#width=500\n\nB\n'))
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('.embed')?.getAttribute('style')).toBe(
      '--embed-w:500;--embed-rw:500;--embed-rh:281',
    )
  })

  it('keeps a loaded player in a list while its other items change', () => {
    const container = document.createElement('div')
    patch(container, render('a\n\n- https://youtu.be/dQw4w9WgXcQ\n- x\n\nb\n'))
    const frame = loadEmbed(container.querySelector('[data-embed-src]') as Element)
    expect(frame).not.toBeNull()

    patch(container, render('a\n\n- https://youtu.be/dQw4w9WgXcQ\n- xy\n\nb\n'))
    expect(container.querySelector('iframe')).toBe(frame)
    expect(container.querySelectorAll('li')[1]?.textContent).toBe('xy')

    patch(container, render('> a\n\n- https://youtu.be/dQw4w9WgXcQ\n- xy\n- z\n\nb\n'))
    expect(container.querySelector('iframe')).toBe(frame)
    expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      expect.anything(),
      'xy',
      'z',
    ])

    // Editing the player's own item still turns it back into a placeholder.
    patch(container, render('> a\n\n- https://youtu.be/dQw4w9WgXcQ?t=5\n- xy\n- z\n\nb\n'))
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.innerHTML).toBe(
      html('> a\n\n- https://youtu.be/dQw4w9WgXcQ?t=5\n- xy\n- z\n\nb\n'),
    )
  })

  it('keeps a loaded player in the block that still holds it, not one shaped the same', () => {
    // A new quote, above or below, competes with the player's own while that changes.
    for (const [edited, at] of [
      ['> new quote\n\nseparator\n\n> https://youtu.be/dQw4w9WgXcQ\n>\n> edited\n', 1],
      ['> https://youtu.be/dQw4w9WgXcQ\n>\n> edited\n\nseparator\n\n> new quote\n', 0],
    ] as const) {
      const container = document.createElement('div')
      patch(container, render('> https://youtu.be/dQw4w9WgXcQ\n>\n> old\n'))
      const frame = loadEmbed(container.querySelector('[data-embed-src]') as Element)
      expect(frame).not.toBeNull()

      patch(container, render(edited))
      expect(container.querySelector('iframe')).toBe(frame)
      const quotes = container.querySelectorAll('blockquote')
      expect(quotes[at]?.contains(frame)).toBe(true)
      expect(quotes[at]?.textContent).toContain('edited')
      expect(quotes[1 - at]?.textContent).toContain('new quote')
    }
  })

  it('keeps a ticked "Always load" box in a list while its other items change, not once its URL changes', () => {
    const container = document.createElement('div')
    patch(container, render('- https://vimeo.com/76979871\n- Original sibling\n'))
    const box = () => container.querySelector('.embed-remember') as Element
    const ticked = box()
    expect(toggleRemember(ticked)).toBe(true)

    patch(container, render('- https://vimeo.com/76979871\n- Edited sibling\n'))
    expect(box()).toBe(ticked)
    expect(box().getAttribute('aria-checked')).toBe('true')
    expect(container.querySelectorAll('li')[1]?.textContent).toBe('Edited sibling')

    patch(container, render('- https://vimeo.com/1\n- Edited sibling\n'))
    expect(box().getAttribute('aria-checked')).toBe('false')
    expect(container.innerHTML).toBe(html('- https://vimeo.com/1\n- Edited sibling\n'))
  })

  it('updates the lines after a loaded player in a list', () => {
    const container = document.createElement('div')
    patch(container, render('a\n\n- https://youtu.be/dQw4w9WgXcQ\n- next\n'))
    loadEmbed(container.querySelector('[data-embed-src]') as Element)

    patch(container, render('a\n\nb\n\n- https://youtu.be/dQw4w9WgXcQ\n- next\n'))
    expect([...container.querySelectorAll('li')].map((li) => li.getAttribute('data-line'))).toEqual(
      ['4', '5'],
    )
    expect(container.querySelector('.embed')?.getAttribute('data-line')).toBe('4')
  })

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

  it('ends up with what the source renders to, whatever moved in the middle', () => {
    const steps = [
      'a\n\nb\n\nc\n\nd\n\ne\n',
      'A\n\nb\n\nx\n\nd\n\nE\n',
      'A\n\nd\n\nb\n\nE\n',
      'z\n\nd\n\nd\n\nb\n\nq\n',
      'b\n\nd\n',
      'y\n\nb\n\n# t\n\nd\n\nz\n',
    ]
    const container = document.createElement('div')
    for (const step of steps) {
      patch(container, render(step))
      expect(container.innerHTML).toBe(html(step))
    }
  })

  it('keeps blocks unchanged in the middle in place', () => {
    const container = document.createElement('div')
    patch(container, render('a\n\nb\n\nc\n'))
    const b = container.children[1]
    patch(container, render('A\n\nb\n\nC\n'))
    expect(container.children[1]).toBe(b)
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

describe('snippets', () => {
  const BLOB = 'https://github.com/o/r/blob/main/src/a.ts'
  const RAW = 'https://raw.githubusercontent.com/o/r/main/src/a.ts'
  const FILE = [
    'line 1',
    'line 2',
    'line 3',
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    'line 6',
    'line 7',
    '',
  ].join('\n')
  let fetch: Mock<(src: string, init?: RequestInit) => Promise<Response>>

  beforeEach(() => {
    fetch = vi.fn(() => Promise.resolve(new Response(FILE)))
    vi.stubGlobal('fetch', fetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  function mounted(source: string): HTMLElement {
    const div = document.createElement('div')
    document.body.append(div)
    patch(div, render(source, undefined, []))
    return div
  }

  const placeholderOf = (el: Element) => el.querySelector('[data-embed-src]') as HTMLElement

  it('offers a GitHub file as a placeholder, fetching nothing until asked', () => {
    const div = mounted(`# Code\n\n${BLOB}#L3-L7`)
    const el = placeholderOf(div)
    expect(el.outerHTML).toBe(
      `<div class="embed embed--snippet" data-line="2" data-embed-src="${RAW}" data-embed-lines="3-7">` +
        '<span class="embed-provider">GitHub</span>' +
        '<span class="embed-error" role="status"></span>' +
        '<span class="embed-actions">' +
        '<span class="embed-load" role="button" tabindex="0">Load from raw.githubusercontent.com</span>' +
        '<span class="embed-remember" role="checkbox" aria-checked="false" tabindex="0">Always load GitHub</span></span>' +
        `<a class="embed-link" href="${BLOB}#L3-L7" target="_blank" rel="noopener noreferrer">${BLOB}#L3-L7</a></div>`,
    )
    expect(embedProvider(el)).toBe('github')
    patch(div, render(`# Code, edited\n\n${BLOB}#L3-L7`, undefined, []))
    expect(fetch).not.toHaveBeenCalled()
    expect(div.querySelector('pre')).toBeNull()
  })

  it('names no lines for the whole file', () => {
    const el = placeholderOf(dom(BLOB))
    expect(el.hasAttribute('data-embed-lines')).toBe(false)
    expect(el.hasAttribute('style')).toBe(false)
  })

  it('fetches the raw file without cookies or referrer once asked', async () => {
    const el = placeholderOf(mounted(BLOB))
    expect(await loadSnippet(el)).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [src, init] = fetch.mock.calls[0] ?? []
    expect(src).toBe(RAW)
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
  })

  it('shows the lines asked for, numbered from the first, and keeps the link', async () => {
    const div = mounted(`${BLOB}#L2-L3`)
    const el = placeholderOf(div)
    expect(await loadSnippet(el)).toBe(true)
    expect(el.classList.contains('embed--loaded')).toBe(true)
    const pre = el.querySelector('pre.embed-snippet') as HTMLElement
    // One element per line, numbered by itself, so a number cannot drift off its line.
    const lines = [...pre.querySelectorAll('code > .embed-snippet-line')]
    expect(lines.map((l) => [l.getAttribute('data-n'), l.textContent])).toEqual([
      ['2', 'line 2\n'],
      ['3', 'line 3'],
    ])
    expect(pre.style.getPropertyValue('--snippet-digits')).toBe('1')
    expect(pre.querySelector('code')?.textContent).toBe('line 2\nline 3')
    // A <pre> is generic and may not be labelled; a group may.
    expect(pre.getAttribute('role')).toBe('group')
    expect(pre.getAttribute('aria-label')).toBe('GitHub, lines 2 to 3')
    expect(el.querySelector('.embed-link')?.getAttribute('href')).toBe(`${BLOB}#L2-L3`)
    expect(el.querySelector('.embed-load, .embed-remember')).toBeNull()
    expect(document.activeElement).toBe(pre)
  })

  it('shows markup in the file as text, never as elements', async () => {
    const el = placeholderOf(mounted(`${BLOB}#L4-L5`))
    await loadSnippet(el)
    expect(el.querySelector('code')?.textContent).toBe(
      '<script>alert(1)</script>\n<img src=x onerror="alert(1)">',
    )
    expect(el.querySelector('script, img')).toBeNull()
    const lines = [...(el.querySelector('code')?.children ?? [])]
    expect(lines.map((l) => [l.className, l.children.length])).toEqual([
      ['embed-snippet-line', 0],
      ['embed-snippet-line', 0],
    ])
    expect(el.innerHTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  it('says when lines were left out', async () => {
    fetch.mockImplementation(() =>
      Promise.resolve(new Response(Array.from({ length: 5010 }, (_, i) => `${i + 1}`).join('\n'))),
    )
    const el = placeholderOf(mounted(`${BLOB}#L2-L5010`))
    await loadSnippet(el)
    const gutter = [...el.querySelectorAll('.embed-snippet-line')].map((l) =>
      l.getAttribute('data-n'),
    )
    expect(gutter).toHaveLength(5000)
    expect([gutter[0], gutter.at(-1)]).toEqual(['2', '5001'])
    expect(
      (el.querySelector('pre') as HTMLElement).style.getPropertyValue('--snippet-digits'),
    ).toBe('4')
    expect(el.querySelector('.embed-note')?.textContent).toBe('Showing the first 5000 lines.')
  })

  it('fetches only snippets the preview rendered', async () => {
    const div = document.createElement('div')
    div.append(
      sanitize(
        '<div class="embed embed--snippet" data-embed-src="https://raw.githubusercontent.com/o/r/main/never-rendered.ts"><span class="embed-load">Load</span></div>',
      ),
    )
    const el = placeholderOf(div)
    expect(el).not.toBeNull()
    expect(loadSnippet(el)).toBeNull()
    expect(loadEmbed(el)).toBeNull()
    // Rendered for the whole file, not for these lines.
    const whole = placeholderOf(mounted(BLOB))
    whole.setAttribute('data-embed-lines', '1-2')
    expect(loadSnippet(whole)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    'https://evil.example/o/r/main/src/a.ts',
    `${RAW}?token=1`,
    'http://raw.githubusercontent.com/o/r/main/src/a.ts',
  ])('refuses a placeholder whose src was changed to %s', (src) => {
    const el = placeholderOf(mounted(BLOB))
    el.setAttribute('data-embed-src', src)
    expect(loadSnippet(el)).toBeNull()
    expect(loadEmbed(el)).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps only snippet placeholders pedit would fetch', () => {
    const keep = (attributes: string) =>
      sanitize(`<div class="embed" ${attributes}>x</div>`).querySelector('[data-embed-src]')
    expect(keep(`data-embed-src="${RAW}" data-embed-lines="1-2"`)).not.toBeNull()
    expect(keep(`data-embed-src="${RAW}"`)).not.toBeNull()
    expect(keep('data-embed-src="https://evil.example/a.ts"')).toBeNull()
    expect(keep(`data-embed-src="${RAW}?x=1"`)).toBeNull()
    expect(keep(`data-embed-src="${RAW}" data-embed-lines="2-1"`)).toBeNull()
    expect(keep(`data-embed-src="${RAW}" data-embed-lines="1-2;x"`)).toBeNull()
    // A player has no lines.
    expect(
      keep(
        'data-embed-src="https://player.vimeo.com/video/1" data-embed-lines="1-2"',
      )?.hasAttribute('data-embed-lines'),
    ).toBe(false)
  })

  it('says why it failed, keeps the link and offers to try again', async () => {
    fetch.mockImplementationOnce(() => Promise.resolve(new Response('', { status: 404 })))
    const el = placeholderOf(mounted(BLOB))
    // The live region is there, empty, before anything fails, so the change is announced.
    const status = el.querySelector('.embed-error[role="status"]')
    expect(status?.textContent).toBe('')
    expect(await loadSnippet(el)).toBe(false)
    expect(el.classList.contains('embed--failed')).toBe(true)
    expect(el.querySelector('.embed-error')).toBe(status)
    expect(status?.textContent).toBe('The file was not found. Only public files can be shown.')
    expect(el.querySelector('.embed-load')?.textContent).toBe('Try again')
    expect(el.querySelector('.embed-link')?.getAttribute('href')).toBe(BLOB)
    expect(await loadSnippet(el)).toBe(true)
    expect(el.classList.contains('embed--failed')).toBe(false)
    expect(el.querySelector('.embed-error')).toBeNull()
    expect(el.querySelector('code')?.textContent).toContain('line 7')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('says the network failed, as when the file is not served to this page', async () => {
    fetch.mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')))
    const el = placeholderOf(mounted(BLOB))
    expect(await loadSnippet(el)).toBe(false)
    expect(el.querySelector('.embed-error')?.textContent).toMatch(/could not be loaded/)
  })

  it('shows the loading state and fetches once however often it is asked', async () => {
    let answer: (r: Response) => void = () => {}
    fetch.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const el = placeholderOf(mounted(BLOB))
    const first = loadSnippet(el)
    expect(el.classList.contains('embed--loading')).toBe(true)
    expect(el.querySelector('.embed-load')?.textContent).toBe('Loading…')
    expect(el.querySelector('.embed-load')?.getAttribute('aria-disabled')).toBe('true')
    expect(loadSnippet(el)).toBe(first)
    expect(loadEmbed(el)).toBe(el)
    answer(new Response(FILE))
    expect(await first).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(el.classList.contains('embed--loading')).toBe(false)
  })

  it('keeps a loaded snippet while someone types elsewhere, not once its URL changes', async () => {
    const div = mounted(`a\n\n- ${BLOB}#L1-L2\n- x\n\nb\n`)
    const el = placeholderOf(div)
    await loadSnippet(el)
    const pre = div.querySelector('pre')
    expect(pre).not.toBeNull()

    patch(div, render(`A\n\nnew\n\n- ${BLOB}#L1-L2\n- xy\n\nB\n`, undefined, []))
    expect(div.querySelector('pre')).toBe(pre)
    expect(div.textContent).toContain('xy')
    expect(placeholderOf(div).getAttribute('data-line')).toBe('4')

    patch(div, render(`A\n\nnew\n\n- ${BLOB}#L1-L3\n- xy\n\nB\n`, undefined, []))
    expect(div.querySelector('pre')).toBeNull()
    expect(placeholderOf(div).getAttribute('data-embed-lines')).toBe('1-3')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('writes into a snippet that patch took away without harm', async () => {
    let answer: (r: Response) => void = () => {}
    fetch.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const div = mounted(BLOB)
    const el = placeholderOf(div)
    const loading = loadSnippet(el)
    patch(div, render(`${BLOB}#L1`, undefined, []))
    answer(new Response(FILE))
    expect(await loading).toBe(true)
    expect(div.querySelector('pre')).toBeNull()
    expect(placeholderOf(div).querySelector('.embed-load')?.textContent).toMatch(/^Load from/)
  })

  describe('from the preview pane', () => {
    function memory(initial: string[] = []) {
      const data = new Map<string, string>([[ALWAYS_LOAD_KEY, JSON.stringify(initial)]])
      return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => {
          data.set(k, v)
        },
      }
    }

    async function pane(source: string, always = new AlwaysLoad(memory())) {
      const text = new Y.Doc().getText('content')
      const p = new PreviewPane(text, { load: () => Promise.resolve(preview), alwaysLoad: always })
      document.body.append(p.element)
      text.insert(0, source)
      p.active = true
      await vi.waitFor(() => expect(p.element.querySelector('[data-embed-src]')).not.toBeNull())
      return { element: p.element, text }
    }

    it.each(['click', 'Enter', ' '])('loads the snippet by %j', async (how) => {
      const { element } = await pane(`${BLOB}#L1-L2`)
      const control = element.querySelector('.embed-load') as HTMLElement
      if (how === 'click') control.click()
      else control.dispatchEvent(new KeyboardEvent('keydown', { key: how, bubbles: true }))
      await vi.waitFor(() =>
        expect(element.querySelector('code')?.textContent).toBe('line 1\nline 2'),
      )
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('remembers GitHub when loading with the box ticked', async () => {
      const storage = memory()
      const always = new AlwaysLoad(storage)
      const { element } = await pane(BLOB, always)
      ;(element.querySelector('.embed-remember') as HTMLElement).click()
      ;(element.querySelector('.embed-load') as HTMLElement).click()
      expect(always.ids.get()).toEqual(['github'])
      expect([...storage.data]).toEqual([[ALWAYS_LOAD_KEY, '["github"]']])
      await vi.waitFor(() => expect(element.querySelector('pre')).not.toBeNull())
    })

    it('loads snippets right away once GitHub is always loaded, leaving focus where it is', async () => {
      const before = document.activeElement
      const { element } = await pane(`# Code\n\n${BLOB}#L6-L7`, new AlwaysLoad(memory(['github'])))
      await vi.waitFor(() =>
        expect(element.querySelector('code')?.textContent).toBe('line 6\nline 7'),
      )
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(before)
    })

    it('loads only so many snippets on its own, and the rest on a click', async () => {
      fetch.mockImplementation(() => new Promise(() => {}))
      const count = MAX_REMEMBERED_SNIPPETS + 5
      const links = Array.from(
        { length: count },
        (_, i) => `https://github.com/o/r/blob/main/f${i}.ts`,
      )
      const { element, text } = await pane(links.join('\n\n'), new AlwaysLoad(memory(['github'])))
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(MAX_REMEMBERED_SNIPPETS))
      expect(element.querySelectorAll('.embed--snippet:not(.embed--loaded)')).toHaveLength(5)
      // Later renders do not load more either.
      text.insert(text.length, '\n\nmore')
      await vi.waitFor(() => expect(element.textContent).toContain('more'))
      expect(fetch).toHaveBeenCalledTimes(MAX_REMEMBERED_SNIPPETS)
      ;(
        element.querySelector('.embed--snippet:not(.embed--loaded) .embed-load') as HTMLElement
      ).click()
      expect(fetch).toHaveBeenCalledTimes(MAX_REMEMBERED_SNIPPETS + 1)
    })

    it('does not try a failed snippet again on its own as the file changes', async () => {
      fetch.mockImplementation(() => Promise.resolve(new Response('', { status: 500 })))
      const { element, text } = await pane(BLOB, new AlwaysLoad(memory(['github'])))
      await vi.waitFor(() =>
        expect(element.querySelector('.embed-error')?.textContent).not.toBe(''),
      )
      text.insert(text.length, '\n\nmore')
      await vi.waitFor(() => expect(element.textContent).toContain('more'))
      text.insert(0, 'above\n\n')
      await vi.waitFor(() => expect(element.querySelector('p')?.textContent).toBe('above'))
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(element.querySelector('.embed-error')?.textContent).toContain('HTTP 500')
    })
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
