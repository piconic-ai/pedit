import { describe, expect, it } from 'vitest'
import {
  colorFor,
  parseRoomLocation,
  participants,
  roomSocketUrl,
  safeColor,
  sanitizeUser,
  selectionTint,
} from '../src/room.ts'

const id = 'AAAAAAAAAAAAAAAAAAAAAA'
const key = 'k'.repeat(43)

describe('parseRoomLocation', () => {
  it('reads the id from the path and the key from the fragment', () => {
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: `#${key}` })).toEqual({ id, key })
  })

  it('rejects links without a valid key or id', () => {
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: '' })).toBeNull()
    expect(parseRoomLocation({ pathname: `/r/${id}`, hash: '#short' })).toBeNull()
    expect(parseRoomLocation({ pathname: '/r/bad', hash: `#${key}` })).toBeNull()
    expect(parseRoomLocation({ pathname: '/', hash: `#${key}` })).toBeNull()
  })
})

describe('roomSocketUrl', () => {
  it('builds a key-free WebSocket URL on the same host', () => {
    expect(roomSocketUrl({ protocol: 'https:', host: 'edit.piconic.ai' }, id)).toBe(
      `wss://edit.piconic.ai/api/rooms/${id}/ws`,
    )
    expect(roomSocketUrl({ protocol: 'http:', host: 'localhost:8787' }, id)).toBe(
      `ws://localhost:8787/api/rooms/${id}/ws`,
    )
  })
})

describe('participants', () => {
  it('lists the host first, then self, and reads names from either shape', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { name: 'Bob', color: '#000' } }],
      [2, { user: { name: 'Me', color: '#111' } }],
      [3, { role: 'host', name: 'alice' }],
      [4, {}],
    ])
    const list = participants(states, 2)
    expect(list.map((p) => p.name)).toEqual(['alice', 'Me', 'Bob', 'anonymous'])
    expect(list[0]?.isHost).toBe(true)
    expect(list[1]?.isSelf).toBe(true)
  })

  it('takes the host and what each may do from their links, not their states', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { role: 'host', name: 'claims to host' }],
      [2, { role: 'host', name: 'host' }],
      [3, { name: 'reader' }],
    ])
    const access = { 1: 'comment', 2: 'edit', 3: 'read' } as const
    const list = participants(states, 0, (id) => access[id as 1 | 2 | 3])
    expect(list.map((p) => [p.name, p.isHost, p.access])).toEqual([
      ['host', true, 'edit'],
      ['claims to host', false, 'comment'],
      ['reader', false, 'read'],
    ])
  })

  it('keeps avatars only from known hosts', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, { user: { name: 'A', avatar: 'https://gravatar.com/avatar/x' } }],
      [2, { user: { name: 'B', avatar: 'https://tracker.example/pixel.gif' } }],
    ])
    const [a, b] = participants(states, 0)
    expect(a?.avatar).toBe('https://gravatar.com/avatar/x')
    expect(b && 'avatar' in b).toBe(false)
  })
})

const HOSTILE = 'red; position: fixed; inset: 0; background: url(https://evil.example/t)'

describe('safeColor', () => {
  it.each(['#1f7a64', '#abc', '#1F7A6436'])('accepts %s', (c) => {
    expect(safeColor(c)).toBe(c)
  })

  it.each([HOSTILE, 'red', 'url(x)', '#12', '#1234567890', 42, null])('refuses %j', (c) => {
    expect(safeColor(c)).toBeNull()
  })
})

describe('participants and hostile colours', () => {
  it('never passes on a colour that is not a plain hex colour', () => {
    const states = new Map([
      [1, { role: 'host', user: { name: 'Host', color: HOSTILE } }],
      [2, { user: { name: 'Peer', color: 'url(https://evil.example/t)' } }],
    ])
    expect(participants(states, 3).map((p) => p.color)).toEqual(['#1f7a64', '#7a828d'])
  })
})

describe('sanitizeUser', () => {
  it('replaces hostile colours in place, with the colours pedit would pick', () => {
    const state: Record<string, unknown> = {
      user: { name: 'Mallory', color: HOSTILE, colorLight: HOSTILE },
    }
    expect(sanitizeUser(state, 7)).toBe(true)
    expect(state.user).toEqual({
      name: 'Mallory',
      color: colorFor(7),
      colorLight: selectionTint(colorFor(7)),
    })
  })

  it('keeps a good colour and only fixes the bad one', () => {
    const state: Record<string, unknown> = { user: { color: '#4254b5', colorLight: HOSTILE } }
    sanitizeUser(state, 1)
    expect(state.user).toEqual({ color: '#4254b5', colorLight: selectionTint('#4254b5') })
  })

  it('leaves good or missing colours alone', () => {
    const good = { user: { color: '#4254b5', colorLight: '#4254b536' } }
    expect(sanitizeUser(good, 1)).toBe(false)
    expect(sanitizeUser({ role: 'host' }, 1)).toBe(false)
    expect(sanitizeUser({ user: { name: 'x' } }, 1)).toBe(false)
  })
})
