// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { PreviewPane } from '../src/pane.ts'
import * as preview from '../src/preview.ts'

// The block renderer's module arrives only when the test lets it, after the renderer.
const gate = vi.hoisted(() => {
  const g = { open: () => {}, opened: undefined as unknown as Promise<void> }
  g.opened = new Promise<void>((r) => void (g.open = r))
  return g
})
vi.mock('../src/blockrender.ts', async (original) => {
  await gate.opened
  return await original()
})

const frame = () => new Promise((r) => requestAnimationFrame(r))

describe('PreviewPane while its modules load', () => {
  it('draws the text without any edit when another render starts during the load', async () => {
    const text = new Y.Doc().getText('content')
    text.insert(0, '# Hello')
    const pane = new PreviewPane(text, { load: () => Promise.resolve(preview) })
    pane.active = true
    await frame()
    // The renderer is in, the block renderer is not: a second render starts here.
    pane.refresh()
    await frame()
    expect(pane.element.children).toHaveLength(0)
    gate.open()
    await vi.waitFor(() => expect(pane.element.querySelector('h1')?.textContent).toBe('Hello'))
  })

  it('draws after setText and a hide and show during the load', async () => {
    const text = new Y.Doc().getText('content')
    text.insert(0, 'first')
    const pane = new PreviewPane(text, { load: () => Promise.resolve(preview) })
    pane.active = true
    await frame()
    const other = new Y.Doc().getText('content')
    other.insert(0, 'second')
    pane.setText(other)
    pane.active = false
    pane.active = true
    await frame()
    await vi.waitFor(() => expect(pane.element.textContent).toContain('second'))
  })
})
