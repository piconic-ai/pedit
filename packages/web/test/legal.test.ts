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

  it('terms name the governing law', () => {
    expect(terms).toContain('governed by the laws of Japan')
  })
})
