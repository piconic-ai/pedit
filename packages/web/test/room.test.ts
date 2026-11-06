import { describe, expect, it } from 'vitest'
import { parseRoomLocation } from '../src/room.ts'

const id = 'AAAAAAAAAAAAAAAAAAAAAA'
const key = 'k'.repeat(43)

describe('parseRoomLocation', () => {
  it('reads the id from the path and the key from the fragment', () => {
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: `#${key}` })).toEqual({ id, key })
  })

  it('reads comment-only and read-only links too', () => {
    for (const fragment of [`c.${'C'.repeat(86)}`, `r.${'R'.repeat(128)}`]) {
      expect(parseRoomLocation({ pathname: `/r/${id}`, hash: `#${fragment}` })).toEqual({
        id,
        key: fragment,
      })
    }
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: `#c.${key}` })).toBeNull()
  })

  it('rejects links without a valid key or id', () => {
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: '' })).toBeNull()
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: '#short' })).toBeNull()
    expect(parseRoomLocation({ pathname: '/r/bad', hash: `#${key}` })).toBeNull()
    expect(parseRoomLocation({ pathname: '/', hash: `#${key}` })).toBeNull()
  })
})
