import { describe, expect, it } from 'vitest'
import { blobUrl, socketUrl } from '../../src/core/relay.ts'

describe('relay URLs', () => {
  it('builds the same paths on the origin, with wss for https and ws for http', () => {
    expect(socketUrl(new URL('https://relay.test'), 'r1')).toBe('wss://relay.test/api/rooms/r1/ws')
    expect(socketUrl(new URL('http://localhost:8787'), 'r1')).toBe(
      'ws://localhost:8787/api/rooms/r1/ws',
    )
    expect(blobUrl(new URL('https://relay.test'), 'r1', 'b1')).toBe(
      'https://relay.test/api/rooms/r1/blobs/b1',
    )
  })

  it('keeps a path prefix without doubling its slash', () => {
    expect(socketUrl(new URL('https://x.test/pedit/'), 'r1')).toBe(
      'wss://x.test/pedit/api/rooms/r1/ws',
    )
    expect(blobUrl(new URL('https://x.test/pedit'), 'r1', 'b1')).toBe(
      'https://x.test/pedit/api/rooms/r1/blobs/b1',
    )
  })
})
