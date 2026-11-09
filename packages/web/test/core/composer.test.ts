// @vitest-environment jsdom
import { render } from '@barefootjs/client/runtime'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CommentsView, type CommentTarget, type ThreadList } from '../../src/core/comments.ts'
import '../../src/core/components/CommentComposer.tsx'
import { CommentComposer } from '../../src/core/composer.ts'
import type { FileSet } from '../../src/core/files.ts'
import { Store } from '../../src/core/store.ts'

function setup() {
  const content = new Y.Doc()
  content.getText('content').insert(0, 'hello world!\n')
  const view = new CommentsView(new Y.Doc(), content, { name: () => 'Ada', delayMs: 0 })
  const files = {
    target: new Store<CommentTarget | null>(null),
    comments: new Store<CommentsView | null>(view),
    shown: new Store({}),
    focus: new Store<string | null>(null),
    list: new Store<ThreadList>('resolved'),
    rect: new DOMRect(10, 20, 30, 12) as DOMRect | null,
    targetRect() {
      return this.rect
    },
  }
  const locked = new Store(false)
  let panelOpened = 0
  const composer = new CommentComposer(
    files as unknown as FileSet,
    locked,
    () => panelOpened++,
    () => ({
      width: 800,
      height: 600,
    }),
  )
  const container = document.createElement('div')
  document.body.append(container)
  render(container, 'CommentComposer', {
    button: composer.button,
    composing: composer.composing,
    onOpen: () => composer.open(),
    onSend: (b: string) => composer.send(b),
    onCancel: () => composer.cancel(),
  })
  const $ = <T extends Element>(sel: string) => container.querySelector(sel) as T
  return { view, files, locked, composer, $, opened: () => panelOpened }
}

const click = (el: Element) => (el as HTMLElement).click()
const keydown = (el: Element, init: KeyboardEventInit) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))

describe('CommentComposer', () => {
  it('shows the button by the selection only when there is something to comment on', () => {
    const { $, files, locked, view } = setup()
    expect($<HTMLElement>('.comment-add').hidden).toBe(true)
    files.target.set({ kind: 'text', from: 0, to: 5 })
    expect($<HTMLElement>('.comment-add').hidden).toBe(false)
    expect($('.comment-add').getAttribute('title')).toMatch(/^Add comment \(/)
    expect($<HTMLElement>('.comment-add').style.left).toContain('44px')
    locked.set(true)
    expect($<HTMLElement>('.comment-add').hidden).toBe(true)
    locked.set(false)
    expect($<HTMLElement>('.comment-add').hidden).toBe(false)
    view.roomForMore.set(false)
    expect($<HTMLElement>('.comment-add').hidden).toBe(true)
    view.roomForMore.set(true)
    files.rect = null
    files.target.set({ kind: 'text', from: 1, to: 5 })
    expect($<HTMLElement>('.comment-add').hidden).toBe(true)
    files.comments.set(null)
    files.rect = new DOMRect()
    files.target.set(null)
    expect($<HTMLElement>('.comment-add').hidden).toBe(true)
  })

  it('opens a composer on the frozen target, and sends to it', () => {
    const { $, files, view, composer, opened } = setup()
    files.target.set({ kind: 'text', from: 0, to: 5 })
    click($('.comment-add'))
    expect($<HTMLElement>('.comment-add').hidden).toBe(true)
    const box = $<HTMLTextAreaElement>('.comment-compose textarea')
    expect(box.placeholder).toBe('Comment on the selection')
    expect(box.maxLength).toBeGreaterThan(0)
    // The selection moves while the box is open: the comment stays where it started.
    files.target.set({ kind: 'text', from: 6, to: 11 })
    expect($<HTMLElement>('.comment-add').hidden).toBe(true)
    box.value = 'Which one?'
    keydown(box, { key: 'Enter' })
    expect(view.threads.get()).toHaveLength(0)
    keydown(box, { key: 'Enter', ctrlKey: true })
    const [thread] = view.threads.get()
    expect(thread?.quote).toBe('hello')
    expect(composer.composing.get()).toBeNull()
    expect($('.comment-compose')).toBeNull()
    expect(files.focus.get()).toBe(thread?.id)
    expect(files.list.get()).toBe('open')
    expect(opened()).toBe(1)
    expect($<HTMLElement>('.comment-add').hidden).toBe(false)
  })

  it('stays open on an empty comment, and cancels with the button or Escape', () => {
    const { $, files, view } = setup()
    files.target.set({ kind: 'cells', from: { row: 0, col: 0 }, to: { row: 1, col: 0 } })
    click($('.comment-add'))
    expect($<HTMLTextAreaElement>('.comment-compose textarea').placeholder).toBe(
      'Comment on the cells',
    )
    click($('.comment-compose .comment-primary'))
    expect($('.comment-compose')).not.toBeNull()
    expect(view.threads.get()).toHaveLength(0)
    click($('.comment-compose .comment-text-button'))
    expect($('.comment-compose')).toBeNull()
    click($('.comment-add'))
    keydown($('.comment-compose textarea'), { key: 'Escape' })
    expect($('.comment-compose')).toBeNull()
  })

  it('closes when the room locks or the file changes', () => {
    const { $, files, locked } = setup()
    files.target.set({ kind: 'node', id: 'n1' })
    click($('.comment-add'))
    expect($<HTMLTextAreaElement>('.comment-compose textarea').placeholder).toBe(
      'Comment on the node',
    )
    locked.set(true)
    expect($('.comment-compose')).toBeNull()
    locked.set(false)
    click($('.comment-add'))
    expect($('.comment-compose')).not.toBeNull()
    files.shown.set({})
    expect($('.comment-compose')).toBeNull()
  })

  it('opens nothing from the shortcut without a target', () => {
    const { composer, files } = setup()
    expect(composer.open()).toBe(false)
    files.target.set({ kind: 'text', from: 0, to: 1 })
    expect(composer.open()).toBe(true)
  })
})
