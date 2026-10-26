import { describe, expect, it } from 'vitest'
import { COPIED, shareLinks } from '../src/share.ts'

const fragments = {
  edit: 'S'.repeat(43),
  comment: `c.${'C'.repeat(86)}`,
  read: `r.${'R'.repeat(128)}`,
}

describe('shareLinks', () => {
  it('builds each link from the fragments, never from the address bar', () => {
    const links = shareLinks('https://edit.example', 'AAAAAAAAAAAAAAAAAAAAAA', fragments, true)
    expect(links.map((l) => [l.access, l.label, l.url])).toEqual([
      ['edit', 'Copy edit link', `https://edit.example/r/AAAAAAAAAAAAAAAAAAAAAA#${fragments.edit}`],
      [
        'comment',
        'Copy comment-only link',
        `https://edit.example/r/AAAAAAAAAAAAAAAAAAAAAA#${fragments.comment}`,
      ],
      [
        'read',
        'Copy read-only link',
        `https://edit.example/r/AAAAAAAAAAAAAAAAAAAAAA#${fragments.read}`,
      ],
    ])
    expect(links.every((l) => l.unavailable === undefined)).toBe(true)
    expect(COPIED.comment).toBe('Comment-only link copied.')
  })

  it('offers only the links at or below this browser’s own', () => {
    const { edit: _, ...comment } = fragments
    expect(shareLinks('https://e', 'id', comment, true).map((l) => l.access)).toEqual([
      'comment',
      'read',
    ])
    expect(
      shareLinks('https://e', 'id', { read: fragments.read }, true).map((l) => l.access),
    ).toEqual(['read'])
  })

  it('says a comment-only link is of no use while the host shares no comments', () => {
    const comment = shareLinks('https://e', 'id', fragments, false).find(
      (l) => l.access === 'comment',
    )
    expect(comment?.unavailable).toBe('The host shares no comments.')
  })
})
