import { describe, expect, it } from 'vitest'
import { initials, safeAvatar } from '../../src/core/avatar.ts'

describe('safeAvatar', () => {
  it('accepts https URLs on known avatar hosts only', () => {
    expect(safeAvatar('https://gravatar.com/avatar/abc')).toBe('https://gravatar.com/avatar/abc')
    expect(safeAvatar('https://avatars.githubusercontent.com/u/1')).toBeDefined()
    expect(safeAvatar('http://gravatar.com/avatar/abc')).toBeUndefined()
    expect(safeAvatar('https://tracker.example/pixel.gif')).toBeUndefined()
    expect(safeAvatar('https://gravatar.com.evil.example/x')).toBeUndefined()
    expect(safeAvatar('javascript:alert(1)')).toBeUndefined()
    expect(safeAvatar(42)).toBeUndefined()
  })
})

describe('initials', () => {
  it('takes up to two letters', () => {
    expect(initials('Kenta Kobayashi')).toBe('KK')
    expect(initials('kfly8')).toBe('K')
    expect(initials('first.last')).toBe('FL')
    expect(initials('居間 今')).toBe('居今')
    expect(initials('  ')).toBe('?')
  })
})
