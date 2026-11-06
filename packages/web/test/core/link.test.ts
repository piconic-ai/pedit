import { describe, expect, it } from 'vitest'
import { parseLink } from '../../src/core/link.ts'

const id = 'AAAAAAAAAAAAAAAAAAAAAA'
const key = 'k'.repeat(43)

describe('parseLink', () => {
  it('reads an edit link', () => {
    expect(parseLink(`#${id}.${key}`)).toEqual({ id, key })
  })

  it('reads comment-only and read-only links', () => {
    for (const fragment of [`c.${'C'.repeat(86)}`, `r.${'R'.repeat(128)}`]) {
      expect(parseLink(`#${id}.${fragment}`)).toEqual({ id, key: fragment })
    }
  })

  it('takes the leading # as optional', () => {
    expect(parseLink(`${id}.${key}`)).toEqual({ id, key })
  })

  it('refuses a wrong id length, a missing dot, a bad fragment and an empty hash', () => {
    expect(parseLink(`#${id.slice(1)}.${key}`)).toBeNull()
    expect(parseLink(`#${id}A.${key}`)).toBeNull()
    expect(parseLink(`#${id}${key}`)).toBeNull()
    expect(parseLink(`#${id}.`)).toBeNull()
    expect(parseLink(`#${id}.nope`)).toBeNull()
    expect(parseLink(`#${id}.c.${key}`)).toBeNull()
    expect(parseLink('')).toBeNull()
    expect(parseLink('#')).toBeNull()
  })
})
