// @vitest-environment jsdom
import type { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { monotonic, PreviewPane, scrollTarget } from '../src/pane.ts'
import * as preview from '../src/preview.ts'

describe('scrollTarget', () => {
  const anchors = [
    { line: 0, top: 0 },
    { line: 4, top: 100 },
    { line: 10, top: 400 },
  ]

  it('lines up with the block the editor shows', () => {
    expect(scrollTarget(anchors, 4)).toBe(100)
    expect(scrollTarget(anchors, 10)).toBe(400)
  })

  it('interpolates inside a block', () => {
    expect(scrollTarget(anchors, 2)).toBe(50)
    expect(scrollTarget(anchors, 7)).toBe(250)
  })

  it('stops at the last anchor', () => {
    expect(scrollTarget(anchors, 30)).toBe(400)
    expect(scrollTarget([], 3)).toBe(0)
  })

  it('starts from the top before the first anchor', () => {
    expect(scrollTarget([{ line: 4, top: 200 }], 2)).toBe(100)
  })
})

describe('monotonic', () => {
  it('drops anchors that do not move forward', () => {
    expect(
      monotonic([
        { line: 0, top: 0 },
        { line: 2, top: 50 },
        { line: 2, top: 50 },
        { line: 3, top: 40 },
        { line: 5, top: 90 },
      ]),
    ).toEqual([
      { line: 0, top: 0 },
      { line: 2, top: 50 },
      { line: 5, top: 90 },
    ])
  })
})

describe('PreviewPane', () => {
  function setup(load = () => Promise.resolve(preview)) {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    const rendered = vi.fn()
    const pane = new PreviewPane(text, { load, onRender: rendered })
    return { text, pane, rendered }
  }

  it('renders only while active and follows edits', async () => {
    const load = vi.fn(() => Promise.resolve(preview))
    const { text, pane, rendered } = setup(load)
    text.insert(0, '# Hello')
    await new Promise((r) => setTimeout(r, 50))
    expect(load).not.toHaveBeenCalled()
    expect(pane.element.innerHTML).toBe('')

    pane.active = true
    await vi.waitFor(() => expect(pane.element.querySelector('h1')?.textContent).toBe('Hello'))
    text.insert(text.length, '\n\nworld')
    await vi.waitFor(() => expect(pane.element.querySelector('p')?.textContent).toBe('world'))
    expect(load).toHaveBeenCalledTimes(1)
    expect(rendered).toHaveBeenCalledTimes(2)
  })

  it('renders again on request, with the session images', async () => {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    let url: string | null = null
    const images = {
      lookup: () => (url ? { url } : ('loading' as const)),
      owns: (u: string) => u === url,
      rendered: vi.fn(),
    }
    const pane = new PreviewPane(text, { load: () => Promise.resolve(preview), images })
    text.insert(0, '![](assets/0123456789abcdef0123456789abcdef.png)')
    pane.active = true
    await vi.waitFor(() => expect(pane.element.querySelector('.loading-image')).not.toBeNull())
    url = 'blob:http://localhost/1'
    pane.refresh()
    await vi.waitFor(() => expect(pane.element.querySelector('img')?.getAttribute('src')).toBe(url))
    // Each render tells the resolver it is done, so it knows what is on screen.
    expect(images.rendered).toHaveBeenCalledTimes(2)
  })

  it('shows another text, and follows only that one', async () => {
    const { text, pane, rendered } = setup()
    text.insert(0, 'first file')
    pane.active = true
    await vi.waitFor(() => expect(pane.element.textContent).toContain('first file'))
    const other = new Y.Doc().getText('content')
    other.insert(0, 'second file')
    pane.setText(other)
    await vi.waitFor(() => expect(pane.element.textContent).toContain('second file'))
    const renders = rendered.mock.calls.length
    text.insert(0, 'not shown ')
    await new Promise((r) => setTimeout(r, 50))
    expect(rendered).toHaveBeenCalledTimes(renders)
    other.insert(0, 'edited ')
    await vi.waitFor(() => expect(pane.element.textContent).toContain('edited second file'))
  })

  it('catches up on edits made while hidden', async () => {
    const { text, pane, rendered } = setup()
    text.insert(0, 'first')
    pane.active = true
    await vi.waitFor(() => expect(rendered).toHaveBeenCalledTimes(1))
    pane.active = false
    text.insert(0, 'later')
    await new Promise((r) => setTimeout(r, 50))
    expect(rendered).toHaveBeenCalledTimes(1)
    pane.active = true
    await vi.waitFor(() => expect(pane.element.textContent).toContain('laterfirst'))
  })

  it('says so when the renderer cannot load, and retries on the next edit', async () => {
    const load = vi
      .fn<() => Promise<typeof preview>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(preview)
    const { text, pane } = setup(load)
    text.insert(0, 'hi')
    pane.active = true
    await vi.waitFor(() => expect(pane.element.textContent).toContain('could not be loaded'))
    text.insert(2, '!')
    await vi.waitFor(() => expect(pane.element.textContent).toBe('hi!\n'))
  })
})

describe('PreviewPane.follow', () => {
  function sized<T extends HTMLElement | object>(
    target: T,
    size: { scrollTop?: number; scrollHeight: number; clientHeight: number },
  ): T {
    let top = size.scrollTop ?? 0
    Object.defineProperty(target, 'scrollTop', { get: () => top, set: (v) => void (top = v) })
    Object.defineProperty(target, 'scrollHeight', { value: size.scrollHeight })
    Object.defineProperty(target, 'clientHeight', { value: size.clientHeight })
    return target
  }

  function fakeEditor(scroller: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
    return {
      scrollDOM: sized({}, scroller),
      documentPadding: { top: 0 },
      lineBlockAtHeight: () => ({ from: 0, top: 0, height: 20 }),
      state: { doc: { lines: 3, lineAt: () => ({ number: 1 }) } },
    } as unknown as EditorView
  }

  it('leaves the preview alone when the whole document fits the editor', () => {
    const pane = new PreviewPane(new Y.Doc().getText('content'))
    sized(pane.element, { scrollTop: 120, scrollHeight: 2000, clientHeight: 500 })
    pane.follow(fakeEditor({ scrollTop: 0, scrollHeight: 400, clientHeight: 500 }))
    expect(pane.element.scrollTop).toBe(120)
  })

  it('goes to the bottom with the editor, not before it has scrolled', () => {
    const pane = new PreviewPane(new Y.Doc().getText('content'))
    sized(pane.element, { scrollTop: 120, scrollHeight: 2000, clientHeight: 500 })
    pane.follow(fakeEditor({ scrollTop: 0, scrollHeight: 1000, clientHeight: 500 }))
    expect(pane.element.scrollTop).toBe(0)
    pane.follow(fakeEditor({ scrollTop: 500, scrollHeight: 1000, clientHeight: 500 }))
    expect(pane.element.scrollTop).toBe(1500)
  })
})
