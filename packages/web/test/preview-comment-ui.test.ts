// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView, type ViewUpdate } from '@codemirror/view'
import { editKeys, Relay, TEST_ROOM } from '@pedit/protocol/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockRenderer } from '../src/blockrender.ts'
import { textTarget } from '../src/core/comments.ts'
import { mountTextEditor } from '../src/core/editor.ts'
import { FileSet, type PreviewPlace } from '../src/core/files.ts'
import { openRoom } from '../src/core/open-room.ts'
import { Store } from '../src/core/store.ts'
import { commentOnPreviewSelection } from '../src/previewcomment.ts'

class FakeResize {
  observe() {}
  disconnect() {}
}

function setup(source: string) {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', FakeResize)
  // jsdom has no layout: a rect, and an empty one the selection may end in.
  Range.prototype.getClientRects = () =>
    [
      { top: 10, bottom: 30, width: 5, height: 20 },
      { top: 40, bottom: 40, width: 0, height: 0 },
    ] as unknown as DOMRectList
  const root = document.createElement('article')
  root.getBoundingClientRect = () => ({ left: 100, top: 0, right: 500, bottom: 300 }) as DOMRect
  Object.defineProperty(root, 'clientWidth', { value: 380 })
  document.body.replaceChildren(root)
  const blocks = new BlockRenderer(root)
  blocks.update(source, undefined, 0, [])
  const updates = new Set<(u: ViewUpdate) => void>()
  const view = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [EditorView.updateListener.of((u) => updates.forEach((fn) => fn(u)))],
    }),
  })
  let hooks: PreviewPlace | undefined
  const shown = new Store(0)
  const rendered = new Set<() => void>()
  const pane = {
    element: root,
    active: true,
    blocks,
    onRendered: (fn: () => void) => (rendered.add(fn), () => void rendered.delete(fn)),
  }
  const stop = commentOnPreviewSelection({
    pane,
    textEditor: {
      view,
      onUpdate: (fn) => (updates.add(fn), () => void updates.delete(fn)),
    },
    files: {
      shown: shown as never,
      attachPreview: (h) => ((hooks = h), () => {}),
    },
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
      document.dispatchEvent(new Event('selectionchange'))
      vi.advanceTimersByTime(100)
      return range
    }
    throw new Error('no text')
  }
  const main = () => {
    const s = view.state.selection.main
    return [s.from, s.to]
  }
  return {
    root,
    blocks,
    view,
    hooks: () => hooks as PreviewPlace,
    select,
    main,
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
  it('makes the preview selection the editor selection, without focusing it', () => {
    const t = setup('Hello brave world\n')
    t.select('brave')
    expect(t.main()).toEqual([6, 11])
    expect(t.view.hasFocus).toBe(false)
    t.stop()
  })

  it('gives the composer the mapped range as its target', () => {
    const t = setup('Hello brave world\n')
    t.select('brave')
    const s = t.view.state.selection.main
    expect(textTarget({ from: s.from, to: s.to })).toEqual(textTarget({ from: 6, to: 11 }))
    expect(textTarget({ from: s.from, to: s.to })).not.toBeNull()
    t.stop()
  })

  it('works with the preview alone: the editor is never asked to be shown', () => {
    const t = setup('Hello brave world\n')
    // The editor sits in a hidden part of the page.
    t.view.dom.hidden = true
    t.select('world')
    expect(t.main()).toEqual([12, 17])
    expect(t.hooks().place()).not.toBeNull()
    t.stop()
  })

  it('keeps the selection it made through edits by others', () => {
    const t = setup('Hello brave world\n')
    t.select('brave')
    t.view.dispatch({ changes: { from: 0, insert: 'Oh! ' } })
    expect(t.main()).toEqual([10, 15])
    expect(t.hooks().place()).not.toBeNull()
    t.stop()
  })

  it('lets go of the range on another file', () => {
    const t = setup('Hello brave world\n')
    t.select('brave')
    expect(t.hooks().place()).not.toBeNull()
    t.shown.set(1)
    expect(t.hooks().place()).toBeNull()
    t.stop()
  })

  it('gives no target while the page shows an older text, and one once it renders', () => {
    const t = setup('Intro\n\nHello world\n')
    t.view.dispatch({ changes: { from: 5, insert: 'x' } })
    t.select('world')
    expect(t.view.state.selection.main.empty).toBe(true)
    t.blocks.update('Introx\n\nHello world\n', undefined, 0, [])
    for (const fn of t.rendered) fn()
    vi.advanceTimersByTime(100)
    expect(t.main()).toEqual([14, 19])
    t.stop()
  })

  it('places the button by the preview rect, in its margin, clipped to it', () => {
    const t = setup('Hello brave world\n')
    t.root.style.paddingRight = '40px'
    t.select('brave')
    const place = t.hooks().place()
    // The last non-empty rect (10-30), 16px inside the right edge of the preview.
    expect(place?.y).toBe(20)
    expect(place?.x).toBe(100 + 380 - 16)
    expect(place?.clip).toMatchObject({ left: 100, bottom: 300 })
    // Once the editor's selection is someone else's, the editor places the button.
    t.view.dispatch({ selection: { anchor: 0, head: 5 } })
    expect(t.hooks().place()).toBeNull()
    t.stop()
  })

  it('drops the selection it made once the preview selection is gone', () => {
    const t = setup('Hello brave world\n')
    t.select('brave')
    const text = t.root.querySelector('p')?.firstChild as Text
    document.getSelection()?.collapse(text, 2)
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    expect(t.view.state.selection.main.empty).toBe(true)
    t.stop()
  })

  it('does nothing while the preview is not on screen', () => {
    const t = setup('Hello brave world\n')
    t.pane.active = false
    t.select('brave')
    expect(t.view.state.selection.main.empty).toBe(true)
    t.stop()
  })

  it('drops the selection it made when the selection leaves the preview', () => {
    const t = setup('Hello brave world\n')
    t.select('brave')
    const outside = document.createElement('p')
    outside.textContent = 'panel'
    document.body.append(outside)
    document.getSelection()?.selectAllChildren(outside)
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    expect(t.view.state.selection.main.empty).toBe(true)
    expect(t.hooks().place()).toBeNull()
    // Nothing of someone else's selection is touched.
    t.view.dispatch({ selection: { anchor: 0, head: 5 } })
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    expect(t.main()).toEqual([0, 5])
    t.stop()
  })

  it('sits in the padding of a narrow preview', () => {
    const t = setup('Hello brave world\n')
    t.root.style.paddingRight = '16px'
    t.select('brave')
    expect(t.hooks().place()?.x).toBe(100 + 380 - 8)
    t.stop()
  })

  it('stops listening', () => {
    const t = setup('Hello brave world\n')
    t.select('brave')
    t.stop()
    expect(t.updates.size).toBe(0)
    expect(t.rendered.size).toBe(0)
    t.view.dispatch({ selection: { anchor: 0 } })
    t.select('world')
    expect(t.main()).toEqual([0, 0])
  })
})

describe('with the real editor', () => {
  it('keeps the button placed in the subscribers of a remote insert above the selection', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', FakeResize)
    Range.prototype.getClientRects = () =>
      [{ top: 10, bottom: 30, width: 5, height: 20 }] as unknown as DOMRectList
    Range.prototype.getBoundingClientRect ??= () => new DOMRect()
    const keys = await editKeys()
    const room = await openRoom({
      relay: new URL('https://relay.test'),
      roomId: TEST_ROOM,
      fragment: keys.fragments.edit as string,
      me: { name: 'Guest' },
      createSocket: new Relay().create,
    })
    const files = new FileSet(room, { name: 'Guest' })
    const host = document.body.appendChild(document.createElement('div'))
    const textEditor = mountTextEditor({ room, files, parent: host })
    textEditor.view.dispatch({ changes: { from: 0, insert: 'Hello brave world\n' } })
    const root = document.body.appendChild(document.createElement('article'))
    const blocks = new BlockRenderer(root)
    blocks.update('Hello brave world\n', undefined, 0, [])
    const stop = commentOnPreviewSelection({
      pane: { element: root, active: true, blocks, onRendered: () => () => {} },
      textEditor,
      files,
    })
    const text = root.querySelector('p')?.firstChild as Text
    const range = document.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(100)
    expect(textEditor.view.state.selection.main.from).toBe(6)
    // What the composer does on a change of the selection: ask where the button goes.
    const seen: boolean[] = []
    textEditor.selection.subscribe(() => seen.push(files.targetPlace() !== null))
    textEditor.view.dispatch({ changes: { from: 0, insert: 'Oh! ' } })
    expect(seen).toEqual([true])
    stop()
    textEditor.dispose()
    await room.dispose()
  })
})
