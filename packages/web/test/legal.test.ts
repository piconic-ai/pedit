// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import privacy from '../public/privacy.html?raw'
import terms from '../public/terms.html?raw'

const pages = { terms, privacy }

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

describe('terms and privacy pages', () => {
  it.each(Object.entries(pages))('%s is a plain page with no script', (_name, html) => {
    const doc = parse(html)
    expect(doc.querySelectorAll('script')).toHaveLength(0)
    expect(doc.querySelectorAll('[onclick], [onload], [onerror]')).toHaveLength(0)
    expect(doc.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(0)
    expect(doc.querySelectorAll('img')).toHaveLength(0)
  })

  it.each(Object.entries(pages))('%s names the operator and a way to reach them', (_name, html) => {
    expect(html).toContain('kobaken@piconic.ai')
    expect(html).toContain('https://kobaken.co')
  })

  it.each(Object.entries(pages))('%s says when it was last updated', (_name, html) => {
    expect(html).toMatch(/Last updated: \d{4}-\d{2}-\d{2}/)
  })

  it('the two pages link to each other', () => {
    expect(parse(terms).querySelector('a[href="/privacy"]')).not.toBeNull()
    expect(parse(privacy).querySelector('a[href="/terms"]')).not.toBeNull()
  })

  it.each(Object.entries(pages))(
    '%s says what a kept room stores and for how long',
    (_name, html) => {
      expect(html).toContain('pedit --keep')
      expect(html).toContain('for a day by default')
      expect(html).toMatch(/at most 7 days after the host leaves|up to 7 days/)
    },
  )

  it('privacy says that a room keeps only hashes of its admission tokens', () => {
    expect(privacy).toContain('hashes of the room&rsquo;s admission tokens')
    expect(privacy).not.toContain('as they are')
  })

  it('terms name the governing law', () => {
    expect(terms).toContain('governed by the laws of Japan')
  })
})
