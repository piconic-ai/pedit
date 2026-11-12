import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { formatKeep, linkUrl, parseKeep } from '../src/index.ts'

describe('keep durations', () => {
  it('rejects long malformed durations within a bounded child process', () => {
    const source = new URL('../src/links.ts', import.meta.url).href
    const result = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `import assert from 'node:assert/strict';
         import { parseKeep } from ${JSON.stringify(source)};
         assert.throws(() => parseKeep('0'.repeat(1_000_000)), TypeError);
         console.log('invalid duration rejected');`,
      ],
      { timeout: 5000, encoding: 'utf8' },
    )
    expect(result.trim()).toBe('invalid duration rejected')
  })
  it.each([
    ['0', 0, '0'],
    ['24h', 86400, '1d'],
    ['1h30m', 5400, '90m'],
    ['1h1m1s', 3661, '3661s'],
    ['.5h', 1800, '30m'],
    ['1000ms', 1, '1s'],
    ['1.0000000001s', 1, '1s'],
    ['+2h', 7200, '2h'],
    ['9223372036s', 9223372036, '9223372036s'],
  ])('parses %s and formats whole seconds', (input, seconds, canonical) => {
    expect(parseKeep(input)).toBe(seconds)
    expect(formatKeep(seconds)).toBe(canonical)
    expect(parseKeep(canonical)).toBe(seconds)
  })
  it.each([
    '',
    ' ',
    '-1s',
    '0s',
    '1',
    '0d',
    '.5d',
    '1d2h',
    '1s!',
    '1ms',
    '1h 2m',
    '9223372037s',
    '999999999999999999d',
  ])('rejects %s', (input) => {
    expect(() => parseKeep(input)).toThrow()
  })
  it.each([-1, 0.5, Infinity, NaN, 9223372037])('rejects invalid seconds %s', (seconds) => {
    expect(() => formatKeep(seconds)).toThrow()
  })
})

describe('linkUrl', () => {
  const room = 'a'.repeat(22)
  it.each(['e'.repeat(43), `c.${'c'.repeat(86)}`, `r.${'r'.repeat(128)}`])(
    'keeps the whole fragment in hash',
    (fragment) => {
      const link = `${room}.${fragment}`
      const relay = new URL(linkUrl(link, { relay: 'https://relay.example/prefix/' }))
      expect(relay.pathname).toBe(`/prefix/r/${room}`)
      expect(relay.hash).toBe(`#${fragment}`)
      expect(relay.search).toBe('')
      const page = new URL(linkUrl(link, { page: 'https://app.example/doc?id=1#old' }))
      expect(page.pathname + page.search).toBe('/doc?id=1')
      expect(page.hash).toBe(`#${link}`)
    },
  )
  it.each([
    'https://relay.example/?key=secret',
    'https://relay.example/#secret',
    'https://secret@relay.example',
    'javascript:secret',
    'secret',
  ])('rejects invalid destination without disclosing it', (relay) => {
    expect(() => linkUrl(`${room}.${'e'.repeat(43)}`, { relay })).toThrow(
      /^invalid (relay|link) destination$/,
    )
  })
  it.each([
    'secret',
    'room.secret',
    `${room}.${'e'.repeat(43)}#secret`,
    `${room}/secret.${'e'.repeat(43)}`,
  ])('rejects malformed links without disclosing them', (link) => {
    expect(() => linkUrl(link, { relay: 'https://relay.example' })).toThrow('invalid room link')
  })
})
