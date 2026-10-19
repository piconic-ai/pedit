import { defineProvider, MAX_LINE, onHost } from './define.ts'

const RAW = 'https://raw.githubusercontent.com/'
// GitHub's own rules: letters, digits and inner hyphens, at most 39 for an owner.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
// One segment of a ref or a path as the URL parser writes it, percent-encoding and all.
const SEGMENT = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%[0-9A-Fa-f]{2}){1,255}$/
const MAX_PATH = 2048
// The lines GitHub highlights: #L10, or #L10-L20.
const LINES = /^#L([1-9]\d{0,6})(?:-L([1-9]\d{0,6}))?$/

/** The lines a blob URL's fragment selects, or undefined for the whole file. */
function lines(hash: string): [number, number] | undefined {
  const m = LINES.exec(hash)
  if (!m) return undefined
  const from = Number(m[1])
  const to = m[2] === undefined ? from : Number(m[2])
  return from <= to && to <= MAX_LINE ? [from, to] : undefined
}

export default defineProvider({
  name: 'GitHub',
  fetches: [RAW],
  // A file on github.com (/owner/repo/blob/ref/path), or the raw file it serves
  // (/owner/repo/ref/path), which is what the preview fetches. A ref may hold
  // slashes, so the ref and the path are passed on together, as they are.
  snippet(url) {
    if (url.pathname.length > MAX_PATH) return null
    const [, owner = '', repo = '', ...rest] = url.pathname.split('/')
    if (onHost(url, 'github.com', 'www.github.com')) {
      if (rest.shift() !== 'blob') return null
    } else if (!onHost(url, 'raw.githubusercontent.com')) {
      return null
    }
    if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null
    // A ref and at least one path segment, none empty (no trailing slash).
    if (rest.length < 2 || !rest.every((s) => SEGMENT.test(s) && s !== '.' && s !== '..')) {
      return null
    }
    const src = `${RAW}${owner}/${repo}/${rest.join('/')}`
    const range = lines(url.hash)
    return range ? { src, lines: range } : { src }
  },
})
