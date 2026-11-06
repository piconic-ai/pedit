import { describe, expect, it } from 'vitest'
import {
  avatarFor,
  fetchIdentity,
  gravatarUrl,
  IDENTITY_PATH,
  parseIdentity,
} from '../src/identity.ts'

describe('parseIdentity', () => {
  it('reads the name, email and OIDC picture that Access returns', () => {
    expect(
      parseIdentity({
        name: ' Kenta ',
        email: 'k@example.com',
        oidc_fields: { picture: 'https://lh3.googleusercontent.com/a/x' },
        idp: { type: 'google' },
      }),
    ).toEqual({
      name: 'Kenta',
      email: 'k@example.com',
      picture: 'https://lh3.googleusercontent.com/a/x',
    })
  })

  it('falls back to the local part of the email', () => {
    expect(parseIdentity({ name: '', email: 'kfly8@example.com' })).toEqual({
      name: 'kfly8',
      email: 'kfly8@example.com',
    })
  })

  it('rejects anything without a name or email', () => {
    expect(parseIdentity(null)).toBeNull()
    expect(parseIdentity('x')).toBeNull()
    expect(parseIdentity({ err: 'no identity' })).toBeNull()
  })
})

describe('fetchIdentity', () => {
  const respond =
    (body: string, type: string, status = 200) =>
    async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(IDENTITY_PATH)
      return new Response(body, { status, headers: { 'content-type': type } })
    }

  it('returns the identity when Access answers', async () => {
    const f = respond('{"name":"Kenta","email":"k@example.com"}', 'application/json')
    expect(await fetchIdentity(f as typeof fetch)).toEqual({
      name: 'Kenta',
      email: 'k@example.com',
    })
  })

  it('returns null without Access', async () => {
    expect(await fetchIdentity(respond('<html>', 'text/html') as typeof fetch)).toBeNull()
    expect(await fetchIdentity(respond('{}', 'application/json', 404) as typeof fetch)).toBeNull()
    const offline = (async () => {
      throw new TypeError('network')
    }) as typeof fetch
    expect(await fetchIdentity(offline)).toBeNull()
  })
})

describe('avatarFor', () => {
  it('uses a Gravatar SHA-256 of the normalized email', async () => {
    // sha256("test@example.com")
    const hash = '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b'
    expect(await gravatarUrl(' Test@Example.com ')).toBe(
      `https://gravatar.com/avatar/${hash}?s=64&d=404`,
    )
    expect(await avatarFor({ name: 't', email: 'test@example.com' })).toContain(hash)
  })

  it('prefers the IdP picture, ignoring one from an unknown host', async () => {
    const picture = 'https://avatars.githubusercontent.com/u/1'
    expect(await avatarFor({ name: 't', email: 'test@example.com', picture })).toBe(picture)
    expect(
      await avatarFor({ name: 't', email: 'test@example.com', picture: 'https://x.example/a.png' }),
    ).toContain('gravatar.com')
    expect(await avatarFor({ name: 't' })).toBeUndefined()
  })
})
