import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToTest } from '@barefootjs/test'
import { describe, expect, it } from 'vitest'

const dir = join(import.meta.dirname, '../src/components')
const components = readdirSync(dir).filter((f) => f.endsWith('.tsx'))

// The compiler's IR for every component: it must compile with no errors, and
// the reactive parts must be wired as intended.
describe.each(components)('%s', (file) => {
  const ir = renderToTest(readFileSync(join(dir, file), 'utf8'), file)

  it('compiles without errors', () => {
    expect(ir.errors).toEqual([])
  })
})

describe('EndedBanner IR', () => {
  const file = 'EndedBanner.tsx'
  const ir = renderToTest(readFileSync(join(dir, file), 'utf8'), file)

  it('keeps the copy state as a signal', () => {
    expect(ir.signals).toContain('copy')
  })

  it('has two buttons with click handlers', () => {
    const buttons = ir.findAll({ tag: 'button' })
    expect(buttons).toHaveLength(2)
    for (const b of buttons) expect(b.events).toContain('click')
  })
})

describe('Participants IR', () => {
  const file = 'Participants.tsx'
  const ir = renderToTest(readFileSync(join(dir, file), 'utf8'), file)

  it('keeps whether the names are shown as a signal, and the +N count as a memo', () => {
    expect(ir.signals).toContain('expanded')
    expect(ir.memos).toContain('more')
  })

  it('handles clicks on the participants', () => {
    expect(ir.find({ tag: 'ul' })?.events).toContain('click')
  })
})

describe('Settings IR', () => {
  const file = 'Settings.tsx'
  const ir = renderToTest(readFileSync(join(dir, file), 'utf8'), file)

  it('keeps which page shows as a signal, and the current theme as a memo', () => {
    expect(ir.signals).toContain('gallery')
    expect(ir.memos).toContain('current')
  })
})
