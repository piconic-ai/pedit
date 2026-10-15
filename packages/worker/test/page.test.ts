import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { contentSecurityPolicy } from '@pedit/protocol/csp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../src/index.ts'

const HTML =
  '<!doctype html><html><head><script>boot()</script></head><body><script type="module" src="/assets/i.js"></script></body></html>'

async function sha(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return btoa(String.fromCharCode(...d))
}

function assets(body: string, type = 'text/html; charset=utf-8') {
  return {
    seen: [] as Request[],
    fetch(r: Request) {
      this.seen.push(r)
      return Promise.resolve(
        new Response(r.method === 'HEAD' ? null : body, {
          headers: { 'Content-Type': type, ETag: '"e"' },
        }),
      )
    },
  }
}

function call(
  url: string,
  vars: Record<string, string> = {},
  a = assets(HTML),
  init?: RequestInit,
) {
  return app.fetch(
    new Request(url, init),
    { ...env, ...vars, ASSETS: a } as never,
    createExecutionContext(),
  )
}

afterEach(() => vi.restoreAllMocks())

describe('pages', () => {
  it('sends the policy, the meta tag and the companion headers with the page', async () => {
    const res = await call('https://pedit.test/')
    expect(res.status).toBe(200)
    const hash = await sha('boot()')
    expect(res.headers.get('Content-Security-Policy')).toBe(
      contentSecurityPolicy({
        scriptHashes: [hash],
        media: [],
        origin: new URL('https://pedit.test/'),
      }),
    )
    expect(res.headers.get('Content-Security-Policy')).toContain(`'sha256-${hash}'`)
    const body = await res.text()
    expect(body).toMatch(/<head><meta name="pedit-media-sources" content="" \/>/)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('ETag')).toBeNull()
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })

  it('does the same for a room page', async () => {
    const a = assets(HTML)
    const res = await call('https://pedit.test/r/AAAAAAAAAAAAAAAAAAAAAA', {}, a)
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(new URL(a.seen[0]?.url ?? '').pathname).toBe('/r/AAAAAAAAAAAAAAAAAAAAAA')
  })

  it('puts MEDIA_SOURCES into img-src, media-src and the meta tag', async () => {
    const res = await call('https://pedit.test/', {
      MEDIA_SOURCES: 'https: https://img.example.com/pics/',
    })
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain(' https: https://img.example.com/pics/; media-src')
    expect(csp).toContain('media-src https: https://img.example.com/pics/;')
    expect(await res.text()).toContain('content="https: https://img.example.com/pics/"')
  })

  it.each([
    'https:; script-src *',
    "'unsafe-inline'",
    '*',
    'data:',
    'https://a.com"',
    'https://a.com/?q=1',
  ])('falls back to the strict policy for %j', async (value) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('https://pedit.test/', { MEDIA_SOURCES: value })
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("media-src 'none'")
    expect(csp).not.toContain('script-src *')
    expect(await res.text()).toContain('content=""')
    expect(spy).toHaveBeenCalled()
  })

  it('leaves other files alone, apart from nosniff', async () => {
    const res = await call('https://pedit.test/install.sh', {}, assets('echo hi', 'text/plain'))
    expect(await res.text()).toBe('echo hi')
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('never lets the asset server answer 304 for a page', async () => {
    const a = assets(HTML)
    await call('https://pedit.test/', {}, a, {
      headers: {
        'Sec-Fetch-Mode': 'navigate',
        'If-None-Match': '"e"',
        'If-Modified-Since': 'Tue, 01 Jan 2030 00:00:00 GMT',
      },
    })
    await call('https://pedit.test/r/x', {}, a, {
      headers: { Accept: 'text/html', 'If-None-Match': '"e"' },
    })
    expect(a.seen[0]?.headers.get('If-None-Match')).toBeNull()
    expect(a.seen[0]?.headers.get('If-Modified-Since')).toBeNull()
    expect(a.seen[1]?.headers.get('If-None-Match')).toBeNull()
  })

  it('lets built files revalidate', async () => {
    const a = assets('x()', 'text/javascript')
    await call('https://pedit.test/assets/i.js', {}, a, {
      headers: { Accept: '*/*', 'Sec-Fetch-Mode': 'cors', 'If-None-Match': '"e"' },
    })
    expect(a.seen[0]?.headers.get('If-None-Match')).toBe('"e"')
  })

  it('protects the fallback page under /assets/ too', async () => {
    // The assets answer a navigation to a missing file with index.html.
    const res = await call('https://pedit.test/assets/missing.js', {}, assets(HTML), {
      headers: { 'Sec-Fetch-Mode': 'navigate' },
    })
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(await res.text()).toContain('pedit-media-sources')
  })

  it('keeps /api/* away from the assets', async () => {
    const a = assets(HTML)
    const created = await call('https://pedit.test/api/rooms', {}, a, { method: 'POST' })
    expect(created.status).toBe(201)
    expect(created.headers.get('Content-Type')).toMatch(/json/)
    const missing = await call('https://pedit.test/api/nope', {}, a)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('Content-Type')).toMatch(/text\/plain/)
    expect(a.seen).toHaveLength(0)
  })

  it('answers HEAD with a policy', async () => {
    const res = await call('https://pedit.test/', {}, assets(HTML), { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
  })

  it('allows the WebSocket of an http origin', async () => {
    const res = await call('http://localhost:8787/')
    expect(res.headers.get('Content-Security-Policy')).toContain(
      "connect-src 'self' ws://localhost:8787;",
    )
  })
})

describe('plain HTTP', () => {
  it('redirects a page to HTTPS, keeping the path and query', async () => {
    const a = assets(HTML)
    const res = await call('http://pedit.test/r/AAAAAAAAAAAAAAAAAAAAAA?x=1', {}, a)
    expect(res.status).toBe(301)
    expect(res.headers.get('Location')).toBe('https://pedit.test/r/AAAAAAAAAAAAAAAAAAAAAA?x=1')
    expect(a.seen).toHaveLength(0)
  })

  it('redirects the API too, keeping the method', async () => {
    const created = await call('http://pedit.test/api/rooms', {}, assets(HTML), { method: 'POST' })
    expect(created.status).toBe(308)
    expect(created.headers.get('Location')).toBe('https://pedit.test/api/rooms')
    const socket = await call('http://pedit.test/api/rooms/AAAAAAAAAAAAAAAAAAAAAA/ws')
    expect(socket.status).toBe(301)
  })

  it('leaves loopback alone, for wrangler dev', async () => {
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', 'pedit.localhost']) {
      const res = await call(`http://${host}/`)
      expect(res.status).toBe(200)
      expect(res.headers.get('Strict-Transport-Security')).toBeNull()
    }
  })

  it('tells browsers to stay on HTTPS, for this host only', async () => {
    for (const path of ['/', '/assets/i.js']) {
      const res = await call(`https://pedit.test${path}`)
      expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000')
    }
  })
})
