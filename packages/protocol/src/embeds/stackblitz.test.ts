import { describe, expect, it } from 'vitest'
import { allowOf, sandboxOf } from './define.ts'
import stackblitz from './stackblitz.ts'

const embed = (href: string) => stackblitz.embed?.(new URL(href)) ?? null
const EDIT = 'https://stackblitz.com/edit/vitejs-vite-abc'

describe('stackblitz', () => {
  it.each([
    [`${EDIT}`, `${EDIT}?embed=1`],
    [`${EDIT}/`, `${EDIT}?embed=1`],
    [`${EDIT}?file=src/main.ts`, `${EDIT}?embed=1&file=src/main.ts`],
    [`${EDIT}?view=preview&file=index.html&ctl=1`, `${EDIT}?embed=1&file=index.html&view=preview`],
    [`${EDIT}?embed=1&file=a.ts&view=both`, `${EDIT}?embed=1&file=a.ts&view=both`],
    ['https://stackblitz.com/github/user/repo', 'https://stackblitz.com/github/user/repo?embed=1'],
    [
      'https://stackblitz.com/github/user/repo.js/tree/main/examples',
      'https://stackblitz.com/github/user/repo.js/tree/main/examples?embed=1',
    ],
  ])('embeds %s as %s', (href, src) => {
    expect(embed(href)).toBe(src)
    expect(embed(src)).toBe(src)
  })

  it.each([
    // A file outside the project, or a view it does not have, is left out.
    `${EDIT}?file=../secret`,
    `${EDIT}?file=src/../../x`,
    `${EDIT}?file=./a`,
    `${EDIT}?file=a//b`,
    `${EDIT}?file=a%26view%3Dx`,
    `${EDIT}?view=top`,
  ])('keeps only a file and view it can check in %s', (href) => {
    expect(embed(href)).toBe(`${EDIT}?embed=1`)
  })

  it.each([
    'https://stackblitz.com/',
    'https://stackblitz.com/edit/',
    'https://stackblitz.com/edit/a/b',
    'https://stackblitz.com/github/user',
    'https://stackblitz.com/github/user/..',
    'https://stackblitz.com/github/user/.repo',
    'https://stackblitz.com/fork/x',
    'https://stackblitz.com.evil.example/edit/x',
    'https://www.stackblitz.com/edit/x',
    'https://user@stackblitz.com/edit/x',
    'https://stackblitz.com:81/edit/x',
    'https://stackblitz.com/github/user/repo/tree/a%2f..',
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('never gets downloads or the clipboard to read', () => {
    expect(stackblitz.size).toEqual({ ratio: '4/3' })
    expect(sandboxOf(stackblitz)).toBe(
      'allow-scripts allow-same-origin allow-popups allow-forms allow-modals',
    )
    expect(allowOf(stackblitz)).toBe('cross-origin-isolated; clipboard-write; fullscreen')
  })
})
