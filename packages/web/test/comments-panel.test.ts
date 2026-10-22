// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  CommentsView,
  type CommentTarget,
  colorOf,
  type ShownThread,
  shortTime,
} from '../src/comments.ts'
import '../src/components/CommentsPanel.tsx'
import type { Participant } from '../src/room.ts'
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
  const people = new Store<readonly Participant[]>([])
  const shown: ShownThread[] = []
  const container = document.createElement('div')
  document.body.append(container)
  render(container, 'CommentsPanel', {
    comments,
    target: selection,
    locked,
    focus,
    onShow: (t: ShownThread) => shown.push(t),
    people,
  })
  const $ = <T extends Element>(sel: string) => container.querySelector(sel) as T
  const $$ = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[]
  return { meta, view, comments, selection, locked, focus, people, shown, container, $, $$ }
}

const click = (el: Element) => (el as HTMLElement).click()

describe('CommentsPanel', () => {
  /** Starts a thread on the selection through the new comment's card. */
  function comment($: ReturnType<typeof mount>['$'], body: string) {
    $<HTMLTextAreaElement>('.comments-new textarea').value = body
    click($('.comments-new .comment-primary'))
  }

  it('offers a new comment only on a selection, then lists the thread', () => {
    const { $, $$, selection, focus, view } = mount()
    expect($<HTMLElement>('.comments-new').hidden).toBe(true)
    expect($('.comments-empty').textContent).toBe(
      'No comments yet. Select something to comment on it.',
    )
    selection.set({ kind: 'text', from: 6, to: 11 })
    expect($<HTMLElement>('.comments-new').hidden).toBe(false)
    expect($<HTMLTextAreaElement>('.comments-new textarea').placeholder).toBe(
      'Comment on the selection',
    )
    comment($, 'Which world?')
    expect($<HTMLTextAreaElement>('.comments-new textarea').value).toBe('')
    const [thread] = $$('.comment-thread')
    expect(thread?.querySelector('q')?.textContent).toBe('world')
    expect(thread?.querySelector('.comment-body')?.textContent).toBe('Which world?')
    expect(thread?.querySelector('.comment-author')?.textContent).toBe('Ada')
    expect(thread?.querySelector('.comment-avatar')?.textContent).toBe('A')
    expect(
      thread?.querySelector<HTMLElement>('.comment-avatar')?.style.getPropertyValue('--c'),
    ).toBe(colorOf('Ada'))
    expect(focus.get()).toBe(view.threads.get()[0]?.id)
    expect($('.comments-count').textContent).toBe('1')
    expect($<HTMLElement>('.comments-empty').hidden).toBe(true)
  })

  it('grows the new comment as it is written, and lets it go on Cancel', () => {
    const { $, selection } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    const card = $<HTMLElement>('.comments-new')
    const box = $<HTMLTextAreaElement>('.comments-new textarea')
    expect(card.dataset.composing).toBeUndefined()
    box.dispatchEvent(new FocusEvent('focus'))
    expect(card.dataset.composing).toBe('true')
    box.value = 'never mind'
    click($('.comments-new .comment-text-button'))
    expect(box.value).toBe('')
    expect(card.dataset.composing).toBeUndefined()
  })

  it('sends with Ctrl or Cmd and Enter', () => {
    const { $, $$, selection } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    const box = $<HTMLTextAreaElement>('.comments-new textarea')
    box.value = 'quick'
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect($$('.comment-thread')).toHaveLength(0)
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }))
    expect($$('.comment-body').map((b) => b.textContent)).toEqual(['quick'])
  })

  it('takes a reply on the thread in focus only, and shows a thread in the text', () => {
    const { $, $$, selection, focus, shown } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'first')
    expect($<HTMLElement>('.comment-reply').hidden).toBe(false)
    const reply = $<HTMLTextAreaElement>('.comment-reply textarea')
    reply.value = 'second'
    click($('.comment-reply .comment-primary'))
    expect($$('.comment-body').map((b) => b.textContent)).toEqual(['first', 'second'])
    focus.set(null)
    expect($<HTMLElement>('.comment-reply').hidden).toBe(true)
    click($('.comment-thread'))
    expect($<HTMLElement>('.comment-reply').hidden).toBe(false)
    click($('.comment-quote'))
    expect(shown.map((t) => t.quote)).toEqual(['hello'])
  })

  it('resolves a thread into the resolved list, to look back at and reopen', () => {
    const { $, $$, selection, focus } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'done?')
    click($('.comment-resolve'))
    expect(focus.get()).toBeNull()
    expect($$('.comment-thread')).toHaveLength(0)
    expect($('.comments-count').textContent).toBe('')
    const [openTab, resolvedTab] = $$('.comments-tabs button')
    expect(resolvedTab?.textContent).toBe('Resolved 1')
    click(resolvedTab as Element)
    expect(resolvedTab?.getAttribute('aria-selected')).toBe('true')
    expect($<HTMLElement>('.comments-new').hidden).toBe(true)
    const [thread] = $$('.comment-thread')
    expect(thread?.dataset.resolved).toBe('true')
    expect($('.comment-resolve').getAttribute('aria-label')).toBe('Reopen')
    click($('.comment-resolve'))
    expect($$('.comment-thread')).toHaveLength(0)
    expect($('.comments-empty').textContent).toBe('No resolved comments.')
    click(openTab as Element)
    expect($$('.comment-thread')).toHaveLength(1)
  })

  it('shows the list of the thread in focus', () => {
    const { $, $$, selection, focus, view } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'open one')
    const id = focus.get() as string
    click($$('.comments-tabs button')[1] as Element)
    expect($$('.comment-thread')).toHaveLength(0)
    // Clicking its mark in the text puts it in focus: its list comes back.
    focus.set(id)
    expect($$('.comment-thread')).toHaveLength(1)
    expect(view.threads.get()[0]?.resolved).toBe(false)
  })

  it('deletes a comment of ones own only once asked again', () => {
    const { $, $$, selection, view } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'first')
    $<HTMLTextAreaElement>('.comment-reply textarea').value = 'second'
    click($('.comment-reply .comment-primary'))
    const more = $$('.comment-more')
    expect(more.map((b) => b.hidden)).toEqual([false, false])
    const menu = () => $$('.comment-menu')
    expect(menu().every((m) => m.hidden)).toBe(true)
    click(more[1] as Element)
    expect(menu().map((m) => m.hidden)).toEqual([true, false])
    click($$('.comment-delete')[1] as Element)
    const confirm = $$('.comment-confirm')
    expect(confirm.map((c) => c.hidden)).toEqual([true, false])
    expect(confirm[1]?.textContent).toContain('Delete this comment?')
    click(confirm[1]?.querySelector('.comment-text-button') as Element)
    expect($$('.comment-confirm').every((c) => c.hidden)).toBe(true)
    expect(view.threads.get()[0]?.messages).toHaveLength(2)
    click($$('.comment-more')[1] as Element)
    click($$('.comment-delete')[1] as Element)
    click($$('.comment-delete-confirm')[1] as Element)
    expect($$('.comment-body').map((b) => b.textContent)).toEqual(['first'])
    click($('.comment-more'))
    click($('.comment-delete'))
    expect($('.comment-confirm').textContent).toContain('Delete this comment and its thread?')
    click($('.comment-delete-confirm'))
    expect(view.threads.get()).toHaveLength(0)
  })

  it('edits a comment of ones own', () => {
    const { $, $$, selection, view } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'frist')
    click($('.comment-more'))
    click($('.comment-edit'))
    expect($('.comment-body')).toBeNull()
    const box = $<HTMLTextAreaElement>('.comment-editing textarea')
    expect(box.value).toBe('frist')
    box.value = 'first'
    click($('.comment-save'))
    expect($$('.comment-body').map((b) => b.textContent)).toEqual(['first'])
    expect(view.threads.get()[0]?.messages[0]?.body).toBe('first')
  })

  it("offers no menu on other people's comments, and nothing once locked", () => {
    const { $, $$, meta, view, locked } = mount()
    meta.transact(() => {
      const t = new Y.Map<unknown>()
      meta.getMap('comments').set('t1', t)
      t.set('quote', 'hello')
      t.set('anchor', { type: 'node', id: 'n1' })
      const messages = new Y.Map<unknown>()
      t.set('messages', messages)
      messages.set('m1', { author: 'Bo', time: '2026-10-21T00:00:00Z', body: 'hi' })
    })
    view.refresh()
    expect($<HTMLElement>('.comment-more').hidden).toBe(true)
    expect($<HTMLElement>('.comment-resolve').hidden).toBe(false)
    locked.set(true)
    expect($<HTMLElement>('.comment-resolve').hidden).toBe(true)
    expect($$('.comment-reply').every((r) => r.hidden)).toBe(true)
  })

  it('says nothing of where the comments are kept', () => {
    const { container } = mount()
    expect(container.textContent).not.toContain('.pedit')
  })

  it("shows people's text as text, never as markup", () => {
    const { meta, $, view } = mount()
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
    expect($<HTMLElement>('.comment-more').hidden).toBe(true)
  })

  it('takes nothing new once locked, and hides without comments', () => {
    const { $, locked, comments, selection } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    locked.set(true)
    expect($<HTMLElement>('.comments-new').hidden).toBe(true)
    expect($('.comments-empty').textContent).toBe('No comments yet.')
    comments.set(null)
    expect($<HTMLElement>('.comments').hidden).toBe(true)
  })

  it('comments on a cell of a table', () => {
    const { $, $$, selection, shown } = mount('name,age\nAda,36\n', ',')
    selection.set({ kind: 'cells', from: { row: 1, col: 1 }, to: { row: 1, col: 1 } })
    expect($<HTMLTextAreaElement>('.comments-new textarea').placeholder).toBe('Comment on the cell')
    comment($, 'Really?')
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

describe('shortTime', () => {
  const now = new Date(2026, 9, 22, 15, 0)
  it('gives the time of day today, the date before', () => {
    const today = new Date(2026, 9, 22, 9, 5).toISOString()
    expect(shortTime(today, now)).toBe(
      new Date(today).toLocaleTimeString(undefined, { timeStyle: 'short' }),
    )
    const earlier = new Date(2026, 2, 3, 9, 5).toISOString()
    expect(shortTime(earlier, now)).not.toContain('2026')
    expect(shortTime(new Date(2025, 2, 3).toISOString(), now)).toContain('2025')
  })
})

describe('CommentsPanel colours', () => {
  it('gives an author in the room the colour they have in the header', () => {
    const { $, selection, people } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    $<HTMLTextAreaElement>('.comments-new textarea').value = 'hi'
    click($('.comments-new .comment-primary'))
    people.set([{ clientId: 1, name: 'Ada', color: '#123456', isHost: false, isSelf: true }])
    expect($<HTMLElement>('.comment-avatar').style.getPropertyValue('--c')).toBe('#123456')
  })
})

describe('colorOf', () => {
  it('gives a name the same colour every time', () => {
    expect(colorOf('Ada')).toBe(colorOf('Ada'))
    expect(colorOf('Ada')).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
