import { describe, expect, it } from 'vitest'
import { timeLimitText } from '../src/timelimit.ts'

describe('timeLimitText', () => {
  it('names the limit in the largest whole unit', () => {
    expect(timeLimitText(86400)).toBe('24-hour limit')
    expect(timeLimitText(5400)).toBe('90-minute limit')
    expect(timeLimitText(45)).toBe('45-second limit')
  })

  it('names no number when the relay did not say', () => {
    expect(timeLimitText(undefined)).toBe('time limit')
    expect(timeLimitText(0)).toBe('time limit')
  })
})
