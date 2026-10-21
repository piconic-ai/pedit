// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CommentsView, type CommentTarget, type ShownThread } from '../src/comments.ts'
import '../src/components/CommentsPanel.tsx'
import { Store } from '../src/store.ts'
import { parsedAs } from './parsed.ts'

function mount(text = 'hello world!\n', delimiter: string | null = null) {
  const meta = new Y.Doc()
  const content = new Y.Doc()
  content.getText('content').insert(0, text)
  const table = parsedAs(content.getText('content'), delimiter)
  const view = new CommentsView(meta, content, {
    name: () => 'Ada',
    delayMs: 0,
    table,
  })
  const comments = new Store<CommentsView | null>(view)
  const selection = new Store<CommentTarget | null>(null)
  const locked = new Store(false)
  const focus = new Store<string | null>(null)
  const shown: ShownThread[] = []
  const container = document.createElement('div')
  document.body.append(container)
  render(container, 'CommentsPanel', {
    comments,
    target: selection,
    locked,
    focus,
    onShow: (t: ShownThread) => shown.push(t),
  })
  const $ = <T extends Element>(sel: string) => container.querySelector(sel) as T
  const $$ = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[]
  return { meta, view, comments, selection, locked, focus, shown, container, $, $$ }
}

const click = (el: Element) => (el as HTMLElement).click()

describe('CommentsPanel', () => {
  it('comments on the selection, then lists the thread', () => {
    const { $, $$, selection, focus, view } = mount()
    const box = $<HTMLTextAreaElement>('.comments-new textarea')
    expect(box.disabled).toBe(true)
    selection.set({ kind: 'text', from: 6, to: 11 })
    expect(box.disabled).toBe(false)
    box.value = 'Which world?'
    click($('.comments-new button'))
    expect(box.value).toBe('')
    const [thread] = $$('.comment-thread')
    expect(thread?.querySelector('q')?.textContent).toBe('world')
    expect(thread?.querySelector('.comment-body')?.textContent).toBe('Which world?')
    expect(thread?.querySelector('.comment-author')?.textContent).toBe('Ada')
    expect(focus.get()).toBe(view.threads.get()[0]?.id)
    expect($('.comments-count').textContent).toBe('1')
  })

  it('replies, resolves, and shows a thread in the text', () => {
    const { $, $$, selection, view, shown } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    $<HTMLTextAreaElement>('.comments-new textarea').value = 'first'
    click($('.comments-new button'))
    const reply = $<HTMLTextAreaElement>('.comment-reply textarea')
    reply.value = 'second'
    click($('.comment-reply button'))
    expect($$('.comment-body').map((b) => b.textContent)).toEqual(['first', 'second'])
    click($('.comment-quote'))
    expect(shown.map((t) => t.quote)).toEqual(['hello'])
    click($('.comment-resolve'))
    expect($<HTMLElement>('.comment-thread').dataset.resolved).toBe('true')
    expect($('.comment-resolve').textContent).toBe('Reopen')
  })

  it("shows people's text as text, never as markup", () => {
    const { meta, $, $$, view } = mount()
    meta.transact(() => {
      const t = new Y.Map<unknown>()
      meta.getMap('comments').set('t1', t)
      t.set('quote', '<b>q</b>')
      t.set('anchor', { type: 'node', id: 'n1' })
      const messages = new Y.Map<unknown>()
      t.set('messages', messages)
      messages.set('m1', {
        author: '<img src=x onerror=alert(1)>',
        time: '2026-10-21T00:00:00Z',
        body: '<script>alert(1)</script>',
      })
    })
    view.refresh()
    expect($('img')).toBeNull()
    expect($('script')).toBeNull()
    expect($('.comment-author').textContent).toBe('<img src=x onerror=alert(1)>')
    expect($$('.comment-delete')[0]?.hidden).toBe(true)
  })

  it('takes nothing new once locked, and hides without comments', () => {
    const { $, locked, comments } = mount()
    locked.set(true)
    expect($<HTMLElement>('.comments-new').hidden).toBe(true)
    comments.set(null)
    expect($<HTMLElement>('.comments').hidden).toBe(true)
  })

  it('comments on a cell of a table', () => {
    const { $, $$, selection, shown } = mount('name,age\nAda,36\n', ',')
    const box = $<HTMLTextAreaElement>('.comments-new textarea')
    selection.set({ kind: 'cells', from: { row: 1, col: 1 }, to: { row: 1, col: 1 } })
    expect(box.placeholder).toBe('Comment on the cell')
    box.value = 'Really?'
    click($('.comments-new button'))
    const [thread] = $$('.comment-thread')
    expect(thread?.querySelector('q')?.textContent).toBe('36')
    click(thread?.querySelector('.comment-quote') as Element)
    expect(shown.at(-1)?.cells).toEqual({ from: { row: 1, col: 1 }, to: { row: 1, col: 1 } })
  })

  it('offers to comment on a node', () => {
    const { $, selection } = mount()
    selection.set({ kind: 'node', id: 'n1' })
    expect($<HTMLTextAreaElement>('.comments-new textarea').placeholder).toBe('Comment on the node')
  })
})
