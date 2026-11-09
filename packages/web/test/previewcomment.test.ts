// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TextEditor } from '../src/core/editor.ts'
import type { FileSet, PreviewPlace } from '../src/core/files.ts'
import { Store } from '../src/core/store.ts'
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
  Range.prototype.getClientRects = () =>
    [
      { top: 10, bottom: 30, width: 5, height: 20 },
      { top: 40, bottom: 40, width: 0, height: 0 },
    ] as unknown as DOMRectList
  const root = document.createElement('article')
  root.append(render(source))
  document.body.replaceChildren(root)
  const updates = new Set<(u: ViewUpdate) => void>()
  const editor = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [EditorView.updateListener.of((u) => updates.forEach((fn) => fn(u)))],
    }),
  })
  const textEditor = {
    view: editor,
    onUpdate: (fn: (u: ViewUpdate) => void) => (updates.add(fn), () => void updates.delete(fn)),
  } as unknown as TextEditor
  let hooks: PreviewPlace | undefined
  const shown = new Store(0)
  const files = {
    shown,
    attachPreview: (h: PreviewPlace) => ((hooks = h), () => {}),
  } as unknown as FileSet
  const rendered = new Set<() => void>()
  const pane = {
    element: root,
    active: true,
    renderedSource: source as string | null,
    onRendered: (fn: () => void) => (rendered.add(fn), () => void rendered.delete(fn)),
  }
  const stop = commentOnPreviewSelection({
    pane: pane as unknown as PreviewPane,
    textEditor,
    files,
  })
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
  return {
    editor,
    hooks: () => hooks as PreviewPlace,
    select,
    stop,
    pane,
    shown,
    rendered,
    updates,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('commentOnPreviewSelection', () => {
  it('keeps the selection it made through edits by others', () => {
    vi.useFakeTimers()
    const { editor, select, hooks, stop } = setup('Hello brave world\n')
    select('brave')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    editor.dispatch({ changes: { from: 0, insert: 'Oh! ' } })
    const s = editor.state.selection.main
    expect([s.from, s.to]).toEqual([10, 15])
    expect(hooks().place()).not.toBeNull()
    stop()
  })

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

  it('maps nothing while the page shows an older text, and maps once it renders', () => {
    vi.useFakeTimers()
    const { editor, select, pane, rendered, stop } = setup('Hello brave world\n')
    pane.renderedSource = 'Hello world\n'
    select('brave')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    expect(editor.state.selection.main.empty).toBe(true)
    pane.renderedSource = 'Hello brave world\n'
    for (const fn of rendered) fn()
    vi.advanceTimersByTime(100)
    expect(editor.state.selection.main.empty).toBe(false)
    stop()
  })

  it('lets go of the range on another file and stops listening', () => {
    vi.useFakeTimers()
    const { editor, select, hooks, shown, updates, rendered, stop } = setup('Hello brave world\n')
    select('brave')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    expect(hooks().place()).not.toBeNull()
    shown.set(1)
    expect(hooks().place()).toBeNull()
    stop()
    expect(updates.size).toBe(0)
    expect(rendered.size).toBe(0)
    editor.dispatch({ selection: { anchor: 0 } })
  })

  it('drops the selection it made once the preview selection is gone', () => {
    vi.useFakeTimers()
    const { editor, select, stop } = setup('Hello brave world\n')
    select('brave')
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    const sel = document.getSelection()
    const text = document.querySelector('article p span')?.firstChild as Text
    sel?.collapse(text, 2)
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    expect(editor.state.selection.main.empty).toBe(true)
    stop()
  })
})
