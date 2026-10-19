import { describe, expect, it } from 'vitest'
import { allowOf, sandboxOf } from './define.ts'
import loom from './loom.ts'

const embed = (href: string) => loom.embed?.(new URL(href)) ?? null
const ID = '0123456789abcdef0123456789abcdef'
const PLAYER = `https://www.loom.com/embed/${ID}`

describe('loom', () => {
  it.each([
    [`https://www.loom.com/share/${ID}`, PLAYER],
    [`https://loom.com/share/${ID}/`, PLAYER],
    [`https://www.loom.com/share/${ID}?sid=x`, PLAYER],
    [`https://www.loom.com/share/${ID}?t=42&sid=x`, `${PLAYER}?t=42`],
    [`https://www.loom.com/embed/${ID}`, PLAYER],
    [`http://www.loom.com/share/${ID}`, PLAYER],
  ])('embeds %s as %s', (href, src) => {
    expect(embed(href)).toBe(src)
    // The player URL it builds is one it would build again.
    expect(embed(src)).toBe(src)
  })

  it.each([
    // Where to start must be whole seconds.
    [`https://www.loom.com/share/${ID}?t=1m`, PLAYER],
    [`https://www.loom.com/share/${ID}?t=1234567`, PLAYER],
  ])('drops a start it cannot read from %s', (href, src) => {
    expect(embed(href)).toBe(src)
  })

  it.each([
    'https://www.loom.com/',
    `https://www.loom.com/share/${ID.slice(1)}`,
    `https://www.loom.com/share/${ID.toUpperCase()}`,
    `https://www.loom.com/share/${ID}/extra`,
    `https://www.loom.com/looms/${ID}`,
    // Look-alike hosts, user-info, a port, an encoded separator.
    `https://www.loom.com.evil.example/share/${ID}`,
    `https://evil-loom.com/share/${ID}`,
    `https://app.loom.com/share/${ID}`,
    `https://user@www.loom.com/share/${ID}`,
    `https://www.loom.com@evil.example/share/${ID}`,
    `https://www.loom.com:8443/share/${ID}`,
    `https://www.loom.com/share%2F${ID}`,
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('is a 16:9 player with presentation, fullscreen and autoplay', () => {
    expect(loom.size).toEqual({ ratio: '16/9' })
    expect(sandboxOf(loom)).toBe('allow-scripts allow-same-origin allow-popups allow-presentation')
    expect(allowOf(loom)).toBe('fullscreen; autoplay')
  })
})
