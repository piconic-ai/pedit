// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  CommentsView,
  type CommentTarget,
  followFocus,
  type ShownThread,
  shortTime,
  type ThreadList,
} from '../src/comments.ts'
import '../src/components/CommentsPanel.tsx'
import { ContextMenu } from '../src/menu.ts'
import { colorOf, colorsByName } from '../src/room.ts'
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
  const colors = new Store<ReadonlyMap<string, string>>(new Map())
  const list = new Store<ThreadList>('open')
  // As main.ts does: the list follows the thread in focus.
  followFocus(view.threads, focus, list)
  const menu = new ContextMenu(false)
  const open = new Store(true)
  const shown: ShownThread[] = []
  const container = document.createElement('div')
  document.body.append(container)
  render(container, 'CommentsPanel', {
    comments,
    target: selection,
    locked,
    focus,
    onShow: (t: ShownThread) => shown.push(t),
    colors,
    list,
    menu,
    open,
  })
  const $ = <T extends Element>(sel: string) => container.querySelector(sel) as T
  const $$ = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[]
  return {
    meta,
    view,
    comments,
    selection,
    locked,
    focus,
    colors,
    menu,
    open,
    shown,
    container,
    $,
    $$,
  }
}

/** The items of the comment menu open now, by label. */
function menuItems(): Record<string, HTMLButtonElement> {
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  return Object.fromEntries(items.map((b) => [b.textContent ?? '', b]))
}

/** Opens the menu of a comment, and picks an item of it. */
function choose(more: Element, label: string) {
  ;(more as HTMLElement).click()
  menuItems()[label]?.click()
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
    expect($$('.comment-thread')).toHaveLength(1)
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
    const { $, $$, selection, view, menu } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'first')
    $<HTMLTextAreaElement>('.comment-reply textarea').value = 'second'
    click($('.comment-reply .comment-primary'))
    const more = $$('.comment-more')
    expect(more.map((b) => b.hidden)).toEqual([false, false])
    expect(menu.open).toBe(false)
    click(more[1] as Element)
    expect(menu.open).toBe(true)
    expect(Object.keys(menuItems())).toEqual(['Edit', 'Delete'])
    menuItems().Delete?.click()
    expect(menu.open).toBe(false)
    expect($$('.comment-confirm')).toHaveLength(1)
    expect($('.comment-confirm').textContent).toContain('Delete this comment?')
    click($('.comment-confirm .comment-text-button'))
    expect($$('.comment-confirm')).toHaveLength(0)
    expect(view.threads.get()[0]?.messages).toHaveLength(2)
    choose($$('.comment-more')[1] as Element, 'Delete')
    click($('.comment-confirm .comment-danger'))
    expect($$('.comment-body').map((b) => b.textContent)).toEqual(['first'])
    choose($('.comment-more'), 'Delete')
    expect($('.comment-confirm').textContent).toContain('Delete this comment and its thread?')
    click($('.comment-confirm .comment-danger'))
    expect(view.threads.get()).toHaveLength(0)
  })

  it('puts a thread in focus from its quote, and keeps the list on screen once it is resolved', () => {
    const { $, $$, selection, focus, view } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'one')
    selection.set({ kind: 'text', from: 6, to: 11 })
    comment($, 'two')
    focus.set(null)
    click($$('.comment-quote')[1] as Element)
    expect(focus.get()).toBe(view.threads.get()[1]?.id)
    click($$('.comment-resolve')[1] as Element)
    expect(focus.get()).toBeNull()
    expect($$('.comments-tabs button')[0]?.getAttribute('aria-selected')).toBe('true')
    expect($$('.comment-thread')).toHaveLength(1)
  })

  it('keeps an edit open while another menu is looked at', () => {
    const { $, $$, selection, menu } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'first')
    $<HTMLTextAreaElement>('.comment-reply textarea').value = 'second'
    click($('.comment-reply .comment-primary'))
    choose($$('.comment-more')[0] as Element, 'Edit')
    click($$('.comment-more')[1] as Element)
    expect(menu.open).toBe(true)
    menu.close()
    expect($$('.comment-editing')).toHaveLength(1)
  })

  it('offers no edit once the file is full', () => {
    const { $, selection, view } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'first')
    view.roomForMore.set(false)
    click($('.comment-more'))
    expect(menuItems().Edit?.disabled).toBe(true)
    expect(menuItems().Delete?.disabled).toBe(false)
  })

  it('edits a comment of ones own', () => {
    const { $, $$, selection, view } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'frist')
    choose($('.comment-more'), 'Edit')
    expect($('.comment-body')).toBeNull()
    const box = $<HTMLTextAreaElement>('.comment-editing textarea')
    expect(box.value).toBe('frist')
    box.value = 'first'
    click($('.comment-editing .comment-primary'))
    expect($$('.comment-body').map((b) => b.textContent)).toEqual(['first'])
    expect(view.threads.get()[0]?.messages[0]?.body).toBe('first')
  })

  it('lets an edit go on Escape', () => {
    const { $, selection } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    comment($, 'kept')
    choose($('.comment-more'), 'Edit')
    $('.comment-editing textarea').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    expect($('.comment-editing')).toBeNull()
    expect($('.comment-body').textContent).toBe('kept')
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

  it('opens and closes from its title, as the header button does', () => {
    const { $, open } = mount()
    const panel = $<HTMLElement>('.comments')
    expect(panel.dataset.open).toBe('true')
    click($('.comments-toggle'))
    expect(open.get()).toBe(false)
    expect(panel.dataset.open).toBeUndefined()
    expect($('.comments-toggle').getAttribute('aria-expanded')).toBe('false')
    open.set(true)
    expect(panel.dataset.open).toBe('true')
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
    const { $, selection, colors } = mount()
    selection.set({ kind: 'text', from: 0, to: 5 })
    $<HTMLTextAreaElement>('.comments-new textarea').value = 'hi'
    click($('.comments-new .comment-primary'))
    colors.set(new Map([['Ada', '#123456']]))
    expect($<HTMLElement>('.comment-avatar').style.getPropertyValue('--c')).toBe('#123456')
  })
})

describe('colorsByName', () => {
  it('leaves out a name people share with different colours', () => {
    const map = colorsByName([
      { name: 'Ada', color: '#111111' },
      { name: 'anonymous', color: '#222222' },
      { name: 'anonymous', color: '#333333' },
      { name: 'Bo', color: '#444444' },
      { name: 'Bo', color: '#444444' },
    ])
    expect([...map]).toEqual([
      ['Ada', '#111111'],
      ['Bo', '#444444'],
    ])
  })
})

describe('colorOf', () => {
  it('gives a name the same colour every time', () => {
    expect(colorOf('Ada')).toBe(colorOf('Ada'))
    expect(colorOf('Ada')).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
