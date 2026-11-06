import { describe, expect, it } from 'vitest'
import { tableReadOnly } from '../src/table.ts'

describe('tableReadOnly', () => {
  it('is read-only on a link that cannot write, even live', () => {
    expect(tableReadOnly('connected', false, false)).toBe(true)
  })
  it('lets a writer edit while live', () => {
    expect(tableReadOnly('connected', true, false)).toBe(false)
  })
  it('locks a writer while the host is away', () => {
    expect(tableReadOnly('waiting', true, true)).toBe(true)
  })
  it('is read-only for good once the room has ended', () => {
    expect(tableReadOnly('closed', true, false)).toBe(true)
  })
})
