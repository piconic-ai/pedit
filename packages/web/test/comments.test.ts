import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { COMMENT_LIMITS, CommentsView, clean, type ShownThread } from '../src/comments.ts'

function setup(text: string) {
  const meta = new Y.Doc()
  const content = new Y.Doc()
  content.getText('content').insert(0, text)
  let tick = 0
  const view = new CommentsView(meta, content, {
    name: () => 'Ada',
    now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, tick++)),
    delayMs: 0,
  })
  const shown = () => {
    view.refresh()
    return view.threads.get()
  }
  return { meta, content, text: content.getText('content'), view, shown }
}

const only = (threads: readonly ShownThread[]) => {
  expect(threads).toHaveLength(1)
  return threads[0] as ShownThread
}

describe('CommentsView', () => {
  it('starts a thread on the selected text, signed and timed', () => {
    const { view, shown, meta } = setup('hello world!\n')
    const id = view.start(6, 11, 'Which world?')
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/)
    const t = only(shown())
    expect(t).toMatchObject({ state: 'attached', quote: 'world', from: 6, to: 11, resolved: false })
    expect(t.messages).toEqual([
      {
        id: expect.any(String),
        author: 'Ada',
        time: '2026-10-21T00:00:00.000Z',
        body: 'Which world?',
        mine: true,
      },
    ])
    // The shape internal/meta reads.
    const thread = meta.getMap('comments').get(id as string) as Y.Map<unknown>
    expect(thread.get('anchor')).toMatchObject({
      type: 'text',
      start: expect.any(String),
      end: expect.any(String),
    })
  })

  it('follows the text: moved, changed, then gone', () => {
    const { view, shown, text } = setup('hello world!\n')
    view.start(6, 11, 'x')
    text.insert(0, 'Oh, ')
    expect(only(shown())).toMatchObject({ state: 'attached', from: 10, to: 15 })
    // Typed at the edges stays out; inside, it changes the text.
    text.insert(10, '[')
    text.insert(16, ']')
    expect(only(shown())).toMatchObject({ state: 'attached', from: 11, to: 16 })
    text.insert(12, 'OO')
    expect(only(shown())).toMatchObject({ state: 'changed', quote: 'world', live: 'wOOorld' })
    text.delete(11, 7)
    expect(only(shown())).toMatchObject({ state: 'detached', from: -1, to: -1 })
  })

  it('replies, resolves, and edits or deletes only its own comments', () => {
    const { view, shown, meta } = setup('hello world!\n')
    const id = view.start(0, 5, 'first') as string
    expect(view.reply(id, '  second  ')).toBe(true)
    expect(only(shown()).messages.map((m) => m.body)).toEqual(['first', 'second'])
    view.resolve(id, true)
    expect(only(shown()).resolved).toBe(true)

    // A comment from someone else.
    const messages = (meta.getMap('comments').get(id) as Y.Map<unknown>).get(
      'messages',
    ) as Y.Map<unknown>
    messages.set('theirs', { author: 'Bo', time: '2026-10-21T01:00:00Z', body: 'third' })
    const [mine] = only(shown()).messages
    expect(view.edit(id, 'theirs', 'hijacked')).toBe(false)
    expect(view.edit(id, mine?.id as string, 'first, edited')).toBe(true)
    view.remove(id, 'theirs')
    expect(only(shown()).messages.map((m) => m.body)).toEqual(['first, edited', 'second', 'third'])
  })

  it('removes the thread with its last comment', () => {
    const { view, shown } = setup('abc')
    const id = view.start(0, 1, 'x') as string
    view.remove(id, only(shown()).messages[0]?.id as string)
    expect(shown()).toEqual([])
  })

  it('refuses what a file of comments could not hold', () => {
    const { view, shown } = setup('abc')
    expect(view.start(1, 1, 'empty range')).toBeNull()
    expect(view.start(0, 1, '   ')).toBeNull()
    expect(view.start(0, 1, 'x'.repeat(COMMENT_LIMITS.body + 1))).toBeNull()
    expect(shown()).toEqual([])
  })

  it('shows what others wrote as text, without what could reorder it', () => {
    const { meta, shown } = setup('abc')
    meta.transact(() => {
      const t = new Y.Map<unknown>()
      meta.getMap('comments').set('t1', t)
      t.set('anchor', { type: 'text', start: 'not base64!', end: 42 })
      t.set('quote', 'a‮b')
      const messages = new Y.Map<unknown>()
      t.set('messages', messages)
      messages.set('m1', {
        author: 'Eve‮\u0007',
        time: '2026-10-21T00:00:00Z',
        body: '<img src=x onerror=alert(1)>\nline',
      })
      messages.set('bad id!', { author: 'x', time: '2026-10-21T00:00:00Z', body: 'dropped' })
      messages.set('m2', { author: 'x', time: 'yesterday', body: 'dropped' })
      meta.getMap('comments').set('t2', 'not a thread')
    })
    const t = only(shown())
    expect(t).toMatchObject({ id: 't1', state: 'detached', quote: 'ab' })
    expect(t.messages).toEqual([
      {
        id: 'm1',
        author: 'Eve',
        time: '2026-10-21T00:00:00Z',
        body: '<img src=x onerror=alert(1)>\nline',
        mine: false,
      },
    ])
  })

  it('agrees with another peer on where a thread is after an undo', () => {
    // Positions resolve with followUndoneDeletions off: the peer that undid
    // and the one that did not see the same.
    const a = setup('hello world!\n')
    a.view.start(6, 11, 'x')
    const undo = new Y.UndoManager(a.text)
    a.text.delete(6, 5)
    undo.stopCapturing()
    undo.undo()
    expect(a.text.toString()).toBe('hello world!\n')
    expect(only(a.shown()).state).toBe('detached')
  })
})

describe('clean', () => {
  it('drops control and bidi characters, keeping line breaks when asked', () => {
    expect(clean('a\u0000b‮c\nd')).toBe('abcd')
    expect(clean('a\u0000b⁦c\nd\te', true)).toBe('abc\nd\te')
  })
})
