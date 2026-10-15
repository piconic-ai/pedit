import { contentSecurityPolicy, MEDIA_META, parseMediaSources } from '@pedit/protocol/csp'

// index.html's inline scripts have no attributes (web/test/boot.test.ts enforces it).
const INLINE_SCRIPT = /<script>([\s\S]*?)<\/script>/g

/** The CSP script-src hashes (base64 SHA-256) of the page's inline scripts. */
export async function scriptHashes(html: string): Promise<string[]> {
  const hashes: string[] = []
  for (const [, body = ''] of html.matchAll(INLINE_SCRIPT)) {
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
    )
    hashes.push(btoa(String.fromCharCode(...digest)))
  }
  return hashes
}

/** MEDIA_SOURCES as a list. An invalid value is ignored (and logged), which is the strict default. */
export function mediaSourcesFrom(value: string | undefined): string[] {
  const parsed = parseMediaSources(value)
  if (parsed === null) {
    console.error('MEDIA_SOURCES ignored: not a space-separated list of http(s) sources')
  }
  return parsed ?? []
}

// A navigation, or a request that takes HTML: what may come back is a page.
function wantsPage(request: Request): boolean {
  return (
    request.headers.get('Sec-Fetch-Mode') === 'navigate' ||
    (request.headers.get('Accept') ?? '').includes('text/html')
  )
}

/** Serves an asset; HTML responses get the CSP, the media meta and the companion headers. */
export async function servePage(
  request: Request,
  env: { ASSETS: Fetcher; MEDIA_SOURCES?: string },
): Promise<Response> {
  // No 304 for a page: a cached one would keep an old policy after a var change or
  // deploy. Built files keep their revalidation.
  let forAssets = request
  if (wantsPage(request)) {
    const headers = new Headers(request.headers)
    headers.delete('If-None-Match')
    headers.delete('If-Modified-Since')
    forAssets = new Request(request, { headers })
  }
  const asset = await env.ASSETS.fetch(forAssets)
  const out = new Headers(asset.headers)
  out.set('X-Content-Type-Options', 'nosniff')
  out.set('Referrer-Policy', 'no-referrer')
  // Browsers that saw the relay over HTTPS once never try plain HTTP again
  // (see the redirect in index.ts). Only this host, not the rest of the domain.
  if (new URL(request.url).protocol === 'https:') {
    out.set('Strict-Transport-Security', 'max-age=31536000')
  }
  if (!(out.get('Content-Type') ?? '').startsWith('text/html')) {
    return new Response(asset.body, {
      status: asset.status,
      statusText: asset.statusText,
      headers: out,
    })
  }
  const html = await asset.text()
  const media = mediaSourcesFrom(env.MEDIA_SOURCES)
  out.set(
    'Content-Security-Policy',
    contentSecurityPolicy({
      scriptHashes: await scriptHashes(html),
      media,
      origin: new URL(request.url),
    }),
  )
  out.delete('ETag')
  out.delete('Last-Modified')
  out.set('Cache-Control', 'no-cache')
  // Tokens cannot contain quotes, '<', '>' or '&' (parseMediaSources).
  const meta = `<meta name="${MEDIA_META}" content="${media.join(' ')}" />`
  return new HTMLRewriter()
    .on('head', {
      element: (e) => {
        e.prepend(meta, { html: true })
      },
    })
    .transform(new Response(html, { status: asset.status, headers: out }))
}
