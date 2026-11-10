// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import * as blockrender from '../src/blockrender.ts'
import { PreviewPane } from '../src/pane.ts'

const frame = () => new Promise((r) => requestAnimationFrame(r))

// A loader that answers only when the test lets it.
function slow() {
  let done: () => void = () => {}
  const load = vi.fn(
    () =>
      new Promise<typeof blockrender>((r) => {
        done = () => r(blockrender)
      }),
  )
  return { load, finish: () => done() }
}

describe('PreviewPane while its renderer loads', () => {
  it('draws the text without any edit when another render starts during the load', async () => {
    const text = new Y.Doc().getText('content')
    text.insert(0, '# Hello')
    const { load, finish } = slow()
    const pane = new PreviewPane(text, { load })
    pane.active = true
    await frame()
    // A second render starts while the first still waits for the renderer.
    pane.refresh()
    await frame()
    expect(pane.element.children).toHaveLength(0)
    finish()
    await vi.waitFor(() => expect(pane.element.querySelector('h1')?.textContent).toBe('Hello'))
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('draws after setText and a hide and show during the load', async () => {
    const text = new Y.Doc().getText('content')
    text.insert(0, 'first')
    const { load, finish } = slow()
    const pane = new PreviewPane(text, { load })
    pane.active = true
    await frame()
    const other = new Y.Doc().getText('content')
    other.insert(0, 'second')
    pane.setText(other)
    pane.active = false
    pane.active = true
    await frame()
    finish()
    await vi.waitFor(() => expect(pane.element.textContent).toContain('second'))
  })
})
