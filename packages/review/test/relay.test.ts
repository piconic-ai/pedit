import { describe, expect, it } from 'vitest'
import { parseRelayUrl } from '../src/relay.ts'

describe('parseRelayUrl', () => {
  it('takes http(s) URLs without credentials', () => {
    expect(parseRelayUrl('https://r.test')?.origin).toBe('https://r.test')
    expect(parseRelayUrl('http://localhost:8787')?.host).toBe('localhost:8787')
  })

  it.each([null, '', 'nope', 'ftp://r.test', 'https://u@r.test', 'https://u:p@r.test'])(
    'refuses %j',
    (value) => {
      expect(parseRelayUrl(value)).toBeNull()
    },
  )
})
