import { AVATAR_HOSTS } from '@pedit/protocol/avatar-hosts'
import { describe, expect, it } from 'vitest'
import { reviewCSP } from '../src/csp.ts'

const directives = (csp: string) =>
  Object.fromEntries(
    csp.split('; ').map((d) => {
      const [name, ...rest] = d.split(' ')
      return [name, rest.join(' ')]
    }),
  )

describe('reviewCSP', () => {
  it('pins an https relay as https and wss, and allows nothing else', () => {
    const d = directives(reviewCSP({ relay: 'https://edit.piconic.ai' }))
    expect(d['default-src']).toBe("'none'")
    expect(d['script-src']).toBe("'self'")
    expect(d['style-src']).toBe("'self' 'unsafe-inline'")
    expect(d['connect-src']).toBe('https://edit.piconic.ai wss://edit.piconic.ai')
    expect(d['base-uri']).toBe("'none'")
    expect(d['form-action']).toBe("'none'")
    expect(d['object-src']).toBe("'none'")
    expect(d['frame-ancestors']).toBeUndefined()
  })

  it('lists the avatar hosts the core accepts', () => {
    const img = directives(reviewCSP({ relay: 'https://r.test' }))['img-src'] ?? ''
    expect(img.startsWith("'self' blob: ")).toBe(true)
    for (const host of AVATAR_HOSTS) expect(img).toContain(`https://${host}`)
    expect(img).not.toContain('data:')
  })

  it('uses http and ws for a local relay, with its port', () => {
    const d = directives(reviewCSP({ relay: new URL('http://localhost:8787/pedit/') }))
    expect(d['connect-src']).toBe('http://localhost:8787 ws://localhost:8787')
  })

  it('adds frame-ancestors only when given', () => {
    expect(
      directives(reviewCSP({ relay: 'https://r.test', frameAncestors: "'none'" }))[
        'frame-ancestors'
      ],
    ).toBe("'none'")
    expect(
      directives(
        reviewCSP({
          relay: 'https://r.test',
          frameAncestors: ["'self'", 'https://cms.example.com'],
        }),
      )['frame-ancestors'],
    ).toBe("'self' https://cms.example.com")
  })

  it('refuses what is not a relay or a source list', () => {
    expect(() => reviewCSP({ relay: 'ftp://r.test' })).toThrow()
    expect(() => reviewCSP({ relay: 'https://u:p@r.test' })).toThrow()
    expect(() => reviewCSP({ relay: 'nope' })).toThrow()
    expect(() =>
      reviewCSP({ relay: 'https://r.test', frameAncestors: "'none'; script-src *" }),
    ).toThrow()
    expect(() => reviewCSP({ relay: 'https://r.test', frameAncestors: [] })).toThrow()
  })
})
