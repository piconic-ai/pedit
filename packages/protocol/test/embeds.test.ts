import { describe, expect, it } from 'vitest'
import {
  ALLOW_FEATURES,
  allowOf,
  defineProvider,
  isFetchProvider,
  onHost,
  type Provider,
  SANDBOX_BASE,
  SANDBOX_EXTRAS,
  sandboxOf,
} from '../src/embeds/define.ts'
import PROVIDERS from '../src/embeds/index.ts'

declare global {
  interface ImportMeta {
    glob<T>(
      pattern: string | string[],
      options: { eager: true; import: 'default' },
    ): Record<string, T>
  }
}

// Every provider file, by id; define.ts, index.ts and the tests are not providers.
const files = Object.fromEntries(
  Object.entries(
    import.meta.glob<Provider>(['../src/embeds/*.ts', '!../src/embeds/*.test.ts'], {
      eager: true,
      import: 'default',
    }),
  )
    .map(([path, provider]) => [path.replace(/^.*\/|\.ts$/g, ''), provider] as const)
    .filter(([id]) => id !== 'define' && id !== 'index' && !id.endsWith('.test')),
)

describe('the provider registry', () => {
  it('registers every provider file under its file name', () => {
    expect(Object.keys(files).sort()).toEqual(Object.keys(PROVIDERS).sort())
    for (const [id, provider] of Object.entries(PROVIDERS)) expect(files[id]).toBe(provider)
  })

  it('has ids that are safe to store and to put in markup', () => {
    for (const id of Object.keys(PROVIDERS)) expect(id).toMatch(/^[a-z][a-z0-9-]*$/)
  })

  it.each(['frames', 'fetches'] as const)("has none of its %s under another provider's", (key) => {
    const prefixes = Object.entries(PROVIDERS).flatMap(([id, p]) =>
      (p[key] ?? []).map((prefix) => ({ id, url: new URL(prefix) })),
    )
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a.id === b.id) continue
        const under = a.url.origin === b.url.origin && a.url.pathname.startsWith(b.url.pathname)
        expect(under, `${a.url.href} (${a.id}) under ${b.url.href} (${b.id})`).toBe(false)
      }
    }
  })

  it('has every provider either frame or fetch', () => {
    for (const [id, p] of Object.entries(PROVIDERS)) {
      const kinds = [p.frames, p.fetches].filter((k) => k !== undefined)
      expect(kinds, id).toHaveLength(1)
      expect(isFetchProvider(p), id).toBe(p.fetches !== undefined)
    }
  })

  it('names every provider', () => {
    // Which providers a relay frames is its own choice; every one needs a name.
    for (const provider of Object.values(PROVIDERS)) expect(provider.name.trim()).not.toBe('')
  })

  it('has unique display names', () => {
    const names = Object.values(PROVIDERS).map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('builds embed URLs only under their own frames', () => {
    const youtube = PROVIDERS.youtube.embed?.(new URL('https://youtu.be/dQw4w9WgXcQ?t=90'))
    expect(youtube).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90')
    const vimeo = PROVIDERS.vimeo.embed?.(new URL('https://vimeo.com/76979871/abc123'))
    expect(vimeo).toBe('https://player.vimeo.com/video/76979871?h=abc123')
  })

  it('sizes YouTube shorts upright and other players 16:9', () => {
    const size = (p: Provider, href: string) =>
      typeof p.size === 'function' ? p.size(new URL(href)) : p.size
    expect(size(PROVIDERS.youtube, 'https://www.youtube.com/shorts/dQw4w9WgXcQ')).toEqual({
      ratio: '9/16',
    })
    expect(size(PROVIDERS.youtube, 'https://youtu.be/dQw4w9WgXcQ')).toEqual({ ratio: '16/9' })
    expect(size(PROVIDERS.vimeo, 'https://vimeo.com/1')).toEqual({ ratio: '16/9' })
  })
})

describe('frame attributes', () => {
  const base: Provider = { name: 'X', frames: ['https://x.example/'], size: { height: 152 } }

  it('starts every sandbox from the common base', () => {
    expect(sandboxOf(base)).toBe('allow-scripts allow-same-origin allow-popups')
    expect(sandboxOf({ ...base, sandbox: ['allow-forms', 'allow-modals'] })).toBe(
      'allow-scripts allow-same-origin allow-popups allow-forms allow-modals',
    )
  })

  it('joins the permissions policy features', () => {
    expect(allowOf(base)).toBe('')
    expect(allowOf({ ...base, allow: ['fullscreen', 'autoplay'] })).toBe('fullscreen; autoplay')
  })

  it('keeps the YouTube and Vimeo players as they were', () => {
    for (const p of [PROVIDERS.youtube, PROVIDERS.vimeo]) {
      expect(sandboxOf(p)).toBe('allow-scripts allow-same-origin allow-popups allow-presentation')
      expect(allowOf(p)).toBe('fullscreen; picture-in-picture; encrypted-media')
    }
  })

  it('offers no token that could take the tab away or download', () => {
    const tokens: readonly string[] = [...SANDBOX_BASE, ...SANDBOX_EXTRAS]
    expect(tokens.filter((t) => /top-navigation|escape-sandbox|downloads/.test(t))).toEqual([])
    expect(ALLOW_FEATURES).not.toContain('clipboard-read')
  })
})

describe('onHost', () => {
  it('takes only the hosts named, as they are', () => {
    expect(onHost(new URL('https://loom.com/share/x'), 'loom.com', 'www.loom.com')).toBe(true)
    expect(onHost(new URL('http://WWW.LOOM.COM/share/x'), 'loom.com', 'www.loom.com')).toBe(true)
    for (const href of [
      'https://app.loom.com/',
      'https://loom.com.evil.example/',
      'https://evil-loom.com/',
      'https://loom.com./',
    ]) {
      expect(onHost(new URL(href), 'loom.com'), href).toBe(false)
    }
  })

  it.each([
    'https://user@loom.com/share/x',
    'https://user:pass@loom.com/share/x',
    'https://loom.com:8443/share/x',
    'https://loom.com/share%2fx',
    'https://loom.com/share%5Cx',
    'https://loom.com/share/x%2Ey',
  ])('refuses %s, which no provider link carries', (href) => {
    expect(onHost(new URL(href), 'loom.com')).toBe(false)
  })
})

describe('defineProvider', () => {
  it('returns the provider as it is', () => {
    const p: Provider = { name: 'X', frames: ['https://x.example/'], size: { ratio: '4/3' } }
    expect(defineProvider(p)).toBe(p)
  })

  it('rejects what a provider may not have, at compile time', () => {
    const size = { ratio: '16/9' } as const
    const frames = ['https://x.example/'] as const
    const bad = [
      // @ts-expect-error a provider needs a name
      () => defineProvider({ frames, size }),
      // @ts-expect-error frames are required
      () => defineProvider({ name: 'X', size }),
      // @ts-expect-error a size is required
      () => defineProvider({ name: 'X', frames }),
      // @ts-expect-error the id is the key in index.ts, not a field
      () => defineProvider({ id: 'x', name: 'X', frames, size }),
      // @ts-expect-error frames are https
      () => defineProvider({ name: 'X', frames: ['http://x.example/'], size }),
      // @ts-expect-error frames end in '/'
      () => defineProvider({ name: 'X', frames: ['https://x.example'], size }),
      // @ts-expect-error not a ratio
      () => defineProvider({ name: 'X', frames, size: { ratio: 'wide' } }),
      // @ts-expect-error could navigate the editor's tab
      () => defineProvider({ name: 'X', frames, size, sandbox: ['allow-top-navigation'] }),
      () =>
        defineProvider({
          name: 'X',
          frames,
          size,
          // @ts-expect-error could navigate the editor's tab
          sandbox: ['allow-top-navigation-by-user-activation'],
        }),
      // @ts-expect-error no downloads
      () => defineProvider({ name: 'X', frames, size, sandbox: ['allow-downloads'] }),
      // @ts-expect-error the base already has it
      () => defineProvider({ name: 'X', frames, size, sandbox: ['allow-scripts'] }),
      // @ts-expect-error not a permissions policy feature pedit grants
      () => defineProvider({ name: 'X', frames, size, allow: ['clipboard-read'] }),
      // @ts-expect-error one feature per entry
      () => defineProvider({ name: 'X', frames, size, allow: ['fullscreen; camera'] }),
    ]
    expect(bad).toHaveLength(13)
  })

  it('takes a provider that fetches text, and returns it as it is', () => {
    const p = defineProvider({
      name: 'Files',
      fetches: ['https://files.example.com/'],
      snippet: (url) => ({ src: url.href, lines: [1, 2] }),
    })
    expect(isFetchProvider(p)).toBe(true)
    expect(p.snippet(new URL('https://files.example.com/a'))).toEqual({
      src: 'https://files.example.com/a',
      lines: [1, 2],
    })
  })

  it('rejects what a fetch provider may not have, at compile time', () => {
    const fetches = ['https://files.example.com/'] as const
    const snippet = () => null
    const bad = [
      // @ts-expect-error a provider needs a name
      () => defineProvider({ fetches, snippet }),
      // @ts-expect-error a snippet is required
      () => defineProvider({ name: 'X', fetches }),
      // @ts-expect-error fetches are required
      () => defineProvider({ name: 'X', snippet }),
      // @ts-expect-error fetches are https
      () => defineProvider({ name: 'X', fetches: ['http://files.example.com/'], snippet }),
      // @ts-expect-error fetches end in '/'
      () => defineProvider({ name: 'X', fetches: ['https://files.example.com'], snippet }),
      // @ts-expect-error a snippet answers a src
      () => defineProvider({ name: 'X', fetches, snippet: () => 'https://files.example.com/a' }),
      // @ts-expect-error lines are a pair
      () => defineProvider({ name: 'X', fetches, snippet: () => ({ src: 'x', lines: [1] }) }),
      () =>
        defineProvider({
          name: 'X',
          fetches,
          snippet,
          // @ts-expect-error nothing is framed
          frames: ['https://files.example.com/'],
        }),
      // @ts-expect-error no box: a snippet is as tall as its lines
      () => defineProvider({ name: 'X', fetches, snippet, size: { ratio: '16/9' } }),
      // @ts-expect-error no frame, so no sandbox
      () => defineProvider({ name: 'X', fetches, snippet, sandbox: ['allow-forms'] }),
      () =>
        defineProvider({
          name: 'X',
          frames: ['https://x.example/'],
          size: { ratio: '16/9' },
          // @ts-expect-error a frame provider fetches nothing
          snippet,
        }),
    ]
    expect(bad).toHaveLength(11)
  })
})
