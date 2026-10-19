import { describe, expect, it } from 'vitest'
import { allowOf, sandboxOf } from './define.ts'
import observable from './observable.ts'

const embed = (href: string) => observable.embed?.(new URL(href)) ?? null
const PLAYER = 'https://observablehq.com/embed/@d3/bar-chart'

describe('observable', () => {
  it.each([
    ['https://observablehq.com/@d3/bar-chart', PLAYER],
    ['https://observablehq.com/@d3/bar-chart/', PLAYER],
    ['https://observablehq.com/@d3/bar-chart?collection=x', PLAYER],
    ['https://observablehq.com/@d3/bar-chart?cells=chart,legend', `${PLAYER}?cells=chart,legend`],
    ['https://observablehq.com/embed/@d3/bar-chart?cells=chart', `${PLAYER}?cells=chart`],
    // Cells it cannot read are left out: the whole notebook shows.
    ['https://observablehq.com/@d3/bar-chart?cells=a%26b', PLAYER],
    ['https://observablehq.com/@d3/bar-chart?cells=1a', PLAYER],
  ])('embeds %s as %s', (href, src) => {
    expect(embed(href)).toBe(src)
    expect(embed(src)).toBe(src)
  })

  it.each([
    'https://observablehq.com/',
    'https://observablehq.com/@d3',
    'https://observablehq.com/d/abc',
    'https://observablehq.com/@d3/bar-chart/x',
    'https://observablehq.com/@d3/bar.chart',
    'https://observablehq.com.evil.example/@d3/bar-chart',
    'https://api.observablehq.com/@d3/bar-chart',
    'https://user@observablehq.com/@d3/bar-chart',
    'https://observablehq.com:8443/@d3/bar-chart',
    'https://observablehq.com/@d3%2fbar-chart',
  ])('leaves %s alone', (href) => {
    expect(embed(href)).toBeNull()
  })

  it('is a 4:3 document with only the common sandbox', () => {
    expect(observable.size).toEqual({ ratio: '4/3' })
    expect(sandboxOf(observable)).toBe('allow-scripts allow-same-origin allow-popups')
    expect(allowOf(observable)).toBe('fullscreen; clipboard-write')
  })
})
