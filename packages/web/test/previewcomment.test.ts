// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileSet, PreviewPlace } from '../src/core/files.ts'
import type { PreviewPane } from '../src/pane.ts'
import { render } from '../src/preview.ts'
import { commentOnPreviewSelection } from '../src/previewcomment.ts'

class FakeResize {
  observe() {}
  disconnect() {}
}

function setup(source: string) {
  vi.stubGlobal('ResizeObserver', FakeResize)
  // jsdom has no layout.
  Range.prototype.getClientRects = () => [{ top: 10, bottom: 30 }] as unknown as DOMRectList
  const root = document.createElement('article')
  root.append(render(source))
  document.body.replaceChildren(root)
  const editor = new EditorView({ state: EditorState.create({ doc: source }) })
  let hooks: PreviewPlace | undefined
  const files = {
    attachPreview: (h: PreviewPlace) => ((hooks = h), () => {}),
  } as unknown as FileSet
  const pane = { element: root, active: true } as unknown as PreviewPane
  const stop = commentOnPreviewSelection({ pane, editor, files })
  const select = (text: string) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      const at = n.data.indexOf(text)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(n, at)
      range.setEnd(n, at + text.length)
      const sel = document.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      return range
    }
    throw new Error('no text')
  }
  return { editor, hooks: () => hooks as PreviewPlace, select, stop }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('commentOnPreviewSelection', () => {
  it('makes the preview selection the editor selection, without focusing it', () => {
    vi.useFakeTimers()
    const { editor, select, hooks, stop } = setup('Hello brave world\n')
    select('brave')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    const s = editor.state.selection.main
    expect([s.from, s.to]).toEqual([6, 11])
    expect(editor.hasFocus).toBe(false)
    // The button is placed by the preview while the editor's selection is the one made there.
    expect(hooks().place()?.y).toBe(20)
    editor.dispatch({ selection: { anchor: 0, head: 5 } })
    expect(hooks().place()).toBeNull()
    stop()
  })

  it('drops the selection it made once the preview selection is gone', () => {
    vi.useFakeTimers()
    const { editor, select, stop } = setup('Hello brave world\n')
    select('brave')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    const sel = document.getSelection()
    const text = document.querySelector('article p')?.firstChild as Text
    sel?.collapse(text, 2)
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    expect(editor.state.selection.main.empty).toBe(true)
    stop()
  })
})
