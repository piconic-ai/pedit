import { describe, expect, it } from 'vitest'
import { isFetchProvider } from './define.ts'
import github from './github.ts'

const snippet = (href: string) => github.snippet(new URL(href))
const RAW = 'https://raw.githubusercontent.com'

describe('github', () => {
  it.each([
    ['https://github.com/o/r/blob/main/README.md', `${RAW}/o/r/main/README.md`],
    ['https://www.github.com/o/r/blob/main/README.md', `${RAW}/o/r/main/README.md`],
    ['https://GITHUB.com/o/r/blob/main/README.md', `${RAW}/o/r/main/README.md`],
    [
      'https://github.com/piconic-ai/pedit/blob/main/packages/web/src/preview.ts',
      `${RAW}/piconic-ai/pedit/main/packages/web/src/preview.ts`,
    ],
    // A ref with slashes, a tag or a commit: passed on with the path.
    ['https://github.com/o/r/blob/feature/x/src/a.ts', `${RAW}/o/r/feature/x/src/a.ts`],
    ['https://github.com/o/r/blob/v1.2.3/a.go', `${RAW}/o/r/v1.2.3/a.go`],
    [
      'https://github.com/o/r/blob/0123456789abcdef0123456789abcdef01234567/a.go',
      `${RAW}/o/r/0123456789abcdef0123456789abcdef01234567/a.go`,
    ],
    ['https://github.com/o/my.repo_x-1/blob/main/a', `${RAW}/o/my.repo_x-1/main/a`],
    // Encoded characters other than separators stay as the parser wrote them.
    ['https://github.com/o/r/blob/main/a b.md', `${RAW}/o/r/main/a%20b.md`],
    ['https://github.com/o/r/blob/main/文書.md', `${RAW}/o/r/main/%E6%96%87%E6%9B%B8.md`],
    // The query is left out; ?plain=1 is how GitHub shows lines of a Markdown file.
    ['https://github.com/o/r/blob/main/a.md?plain=1', `${RAW}/o/r/main/a.md`],
    // The raw file itself, which is what the preview fetches.
    [`${RAW}/o/r/main/README.md`, `${RAW}/o/r/main/README.md`],
    [`${RAW}/o/r/refs/heads/main/a.ts`, `${RAW}/o/r/refs/heads/main/a.ts`],
  ])('fetches %s from %s', (href, src) => {
    expect(snippet(href)).toEqual({ src })
    // Given the src it built, it builds the same again.
    expect(snippet(src)).toEqual({ src })
  })

  it.each([
    ['#L10', [10, 10]],
    ['#L10-L20', [10, 20]],
    ['#L1', [1, 1]],
    ['#L7-L7', [7, 7]],
    ['#L1-L1000000', [1, 1_000_000]],
  ])('selects the lines of %s', (hash, lines) => {
    expect(snippet(`https://github.com/o/r/blob/main/a.ts${hash}`)).toEqual({
      src: `${RAW}/o/r/main/a.ts`,
      lines,
    })
    expect(snippet(`${RAW}/o/r/main/a.ts${hash}`)?.lines).toEqual(lines)
  })

  it.each([
    '#L20-L10',
    '#L0',
    '#L0-L5',
    '#L01',
    '#L1-L1000001',
    '#L99999999',
    '#L10-20',
    '#l10',
    '#L10C3-L12C5',
    '#L10-L20-L30',
    '#readme',
    '#width=560',
    '#',
  ])('shows the whole file for the fragment %s', (hash) => {
    expect(snippet(`https://github.com/o/r/blob/main/a.ts${hash}`)).toEqual({
      src: `${RAW}/o/r/main/a.ts`,
    })
  })

  it.each([
    // Not a file on github.com.
    'https://github.com/o/r',
    'https://github.com/o/r/blob/main',
    'https://github.com/o/r/blob/main/',
    'https://github.com/o/r/blob/main/dir/',
    'https://github.com/o/r/blob//a.ts',
    'https://github.com/o/r/tree/main/src',
    'https://github.com/o/r/raw/main/a.ts',
    'https://github.com/o/r/blame/main/a.ts',
    'https://github.com/o/r/edit/main/a.ts',
    'https://github.com/o/r/commit/0123456',
    'https://gist.github.com/o/0123456789abcdef',
    'https://gist.githubusercontent.com/o/0123/raw/a.ts',
    `${RAW}/o/r/main`,
    `${RAW}/o/r/main/`,
    // Owners and repositories GitHub would not have.
    'https://github.com/-o/r/blob/main/a.ts',
    'https://github.com/o-/r/blob/main/a.ts',
    'https://github.com/o_x/r/blob/main/a.ts',
    `https://github.com/${'o'.repeat(40)}/r/blob/main/a.ts`,
    'https://github.com/o/r~x/blob/main/a.ts',
    `https://github.com/o/${'r'.repeat(101)}/blob/main/a.ts`,
    // Look-alike hosts and other schemes.
    'https://github.com.evil.example/o/r/blob/main/a.ts',
    'https://evilgithub.com/o/r/blob/main/a.ts',
    'https://api.github.com/o/r/blob/main/a.ts',
    'https://raw.githubusercontent.com.evil.example/o/r/main/a.ts',
    'https://raw.github.com/o/r/main/a.ts',
    'https://github.com@evil.example/o/r/blob/main/a.ts',
    'http://localhost/o/r/blob/main/a.ts',
    // User-info, ports and encoded separators.
    'https://user@github.com/o/r/blob/main/a.ts',
    'https://user:pass@github.com/o/r/blob/main/a.ts',
    'https://github.com:444/o/r/blob/main/a.ts',
    'https://github.com/o/r/blob/main/..%2f..%2fx',
    'https://github.com/o/r/blob/main/a%2Fb.ts',
    'https://github.com/o/r/blob/main/a%5cb.ts',
    'https://github.com/o/r/blob/main/%2e%2e/a.ts',
    `${RAW}/o/r/main/a%2fb.ts`,
    // Too long to be a path.
    `https://github.com/o/r/blob/main/${'a/'.repeat(1100)}a.ts`,
  ])('leaves %s alone', (href) => {
    expect(snippet(href)).toBeNull()
  })

  it('is fetched as text from raw.githubusercontent.com only', () => {
    expect(isFetchProvider(github)).toBe(true)
    expect(github.fetches).toEqual(['https://raw.githubusercontent.com/'])
    expect(github.name).toBe('GitHub')
  })
})
