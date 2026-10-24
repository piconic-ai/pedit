// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderCard } from '../src/cardmarkdown.ts'

const html = (text: string) => {
  const div = document.createElement('div')
  div.append(renderCard(text))
  return div
}

describe('renderCard', () => {
  it('draws links, emphasis, code, lists and headings', () => {
    const el = html('# Title\n\n- *one*\n- `two`\n\n> [docs](https://example.com)')
    expect(el.querySelector('h1')?.textContent).toBe('Title')
    expect([...el.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['one', 'two'])
    expect(el.querySelector('em')?.textContent).toBe('one')
    expect(el.querySelector('code')?.textContent).toBe('two')
    expect(el.querySelector('blockquote a')?.getAttribute('href')).toBe('https://example.com')
  })

  it('opens web and mail links in a new tab', () => {
    const el = html('https://example.com and [mail](mailto:a@example.com)')
    const links = [...el.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com',
      'mailto:a@example.com',
    ])
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('keeps the text of a link it cannot follow, without the href', () => {
    const el = html('[run](javascript:alert(1)) [here](#top) [there](other.md)')
    expect(el.querySelectorAll('a[href]')).toHaveLength(0)
    expect(el.textContent).toContain('run')
    expect(el.textContent).toContain('there')
  })

  it('shows raw HTML as text', () => {
    const el = html('<img src=x onerror="alert(1)"><b id="injected">x</b>')
    expect(el.querySelector('img, b, #injected')).toBeNull()
    expect(el.textContent).toContain('<b id="injected">x</b>')
  })

  it('shows an image as its alt text, loading nothing', () => {
    const el = html('![a cat](https://example.com/cat.png)')
    expect(el.querySelector('img')).toBeNull()
    expect(el.textContent).toBe('a cat')
  })

  it('keeps the line breaks of the text', () => {
    expect(html('one\ntwo').querySelector('p br')).not.toBeNull()
  })
})
