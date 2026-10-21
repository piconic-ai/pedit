import { checkMetaUpdate } from '@pedit/protocol'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addNode, deleteNodes, textOf } from '../src/canvas.ts'
import {
  COMMENT_LIMITS,
  CommentsView,
  clean,
  type ShownThread,
  TextIndex,
} from '../src/comments.ts'
import {
  deleteColumn,
  deleteRow,
  type Edit,
  insertColumn,
  insertRow,
  parse,
  setCell,
} from '../src/csv.ts'
import { parsedAs } from './parsed.ts'

function setup(text: string, delimiter: string | null = null) {
  const meta = new Y.Doc()
  const content = new Y.Doc()
  content.getText('content').insert(0, text)
  const table = parsedAs(content.getText('content'), delimiter)
  let tick = 0
  const view = new CommentsView(meta, content, {
    name: () => 'Ada',
    now: () => new Date(Date.UTC(2026, 9, 21, 0, 0, tick++)),
    delayMs: 0,
    table,
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

  it('takes no change while locked, nor near the limit every peer holds', () => {
    let locked = true
    const { meta, content } = setup('hello world')
    const view = new CommentsView(meta, content, { name: () => 'Ada', locked: () => locked })
    expect(view.start(0, 5, 'no')).toBeNull()
    locked = false
    const id = view.start(0, 5, 'yes')
    expect(id).not.toBeNull()
    locked = true
    view.resolve(id as string, true)
    expect(view.threads.get()[0]?.resolved).toBe(false)
  })

  it('shows no thread the host would not save', () => {
    const { meta, view } = setup('abc')
    meta.transact(() => {
      for (const [id, anchor, time] of [
        ['t1', { type: 'nowhere' }, '2026-10-21T00:00:00Z'],
        ['t2', { type: 'node', id: 'n' }, '2026-13-41T00:00:00Z'],
      ] as const) {
        const t = new Y.Map<unknown>()
        meta.getMap('comments').set(id, t)
        t.set('quote', 'q')
        t.set('anchor', anchor)
        const messages = new Y.Map<unknown>()
        t.set('messages', messages)
        messages.set('m1', { author: 'A', time, body: 'b' })
      }
    })
    view.refresh()
    const shown = view.threads.get()
    expect(shown.map((t) => t.id)).toEqual(['t2'])
    expect(shown[0]?.messages).toEqual([])
  })
})

describe('TextIndex', () => {
  const b64 = (rel: Y.RelativePosition) =>
    btoa(String.fromCharCode(...Y.encodeRelativePosition(rel)))

  it('resolves a position where Yjs does', () => {
    let seed = 11
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const doc = new Y.Doc()
    const other = new Y.Doc()
    const text = doc.getText('content')
    const positions: Y.RelativePosition[] = []
    for (let round = 0; round < 300; round++) {
      const d = rand(2) === 0 ? doc : other
      const t = d.getText('content')
      if (t.length > 0 && rand(3) === 0) t.delete(rand(t.length), 1 + rand(3))
      else t.insert(rand(t.length + 1), 'abcdef'.slice(0, 1 + rand(6)))
      if (rand(3) === 0) t.format(0, Math.min(2, t.length), { bold: true })
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(other))
      Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
      positions.push(
        Y.createRelativePositionFromTypeIndex(text, rand(text.length + 1), rand(2) - 1),
      )
      const index = new TextIndex(text)
      for (const rel of positions) {
        const want = Y.createAbsolutePositionFromRelativePosition(rel, doc, false)
        expect(index.resolve(b64(rel))).toBe(want ? want.index : null)
      }
    }
  })

  it('takes no position a peer could make a root type of', () => {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    text.insert(0, 'hello')
    const named = new Y.RelativePosition(null, 'chosen', null, 0)
    expect(new TextIndex(text).resolve(b64(named))).toBeNull()
    expect(doc.share.has('chosen')).toBe(false)
    expect(new TextIndex(text).resolve('not base64!')).toBeNull()
  })
})

describe('comments on cells', () => {
  /** Edits the text as the table does. */
  const edit = (text: Y.Text, edits: (t: ReturnType<typeof parse>) => Edit[]) => {
    for (const e of [...edits(parse(text.toString()))].sort((a, b) => b.from - a.from)) {
      text.delete(e.from, e.to - e.from)
      text.insert(e.from, e.insert)
    }
  }
  const cell = (row: number, col: number) => ({ row, col })

  it('follows a cell through edits of the table', () => {
    const { view, shown, text } = setup('a,b,c\n1,2,3\n', ',')
    expect(view.startCells(cell(1, 1), cell(1, 1), 'Why 2?')).not.toBeNull()
    expect(only(shown())).toMatchObject({
      state: 'attached',
      quote: '2',
      cells: { from: cell(1, 1), to: cell(1, 1) },
    })
    // Rewritten in place, it is the same cell, changed.
    edit(text, (t) => setCell(t, 1, 1, '22'))
    expect(only(shown())).toMatchObject({ state: 'changed', live: '22' })
    // Its left neighbour's column goes: it moves with its value.
    edit(text, (t) => deleteColumn(t, 0))
    expect(text.toString()).toBe('b,c\n22,3\n')
    expect(only(shown())).toMatchObject({ state: 'changed', cells: { from: cell(1, 0) } })
    // Its own column goes: it is gone, not on a neighbour.
    edit(text, (t) => deleteColumn(t, 0))
    expect(only(shown())).toMatchObject({ state: 'detached', cells: null, from: -1 })
  })

  it('loses a cell whose row is deleted, and its last column', () => {
    const { view, shown, text } = setup('a,b\n1,2\n', ',')
    view.startCells(cell(1, 1), cell(1, 1), 'last')
    view.startCells(cell(0, 0), cell(0, 0), 'first')
    edit(text, (t) => deleteColumn(t, 1))
    const states = () => shown().map((t) => [t.quote, t.state])
    expect(states()).toContainEqual(['2', 'detached'])
    expect(states()).toContainEqual(['a', 'attached'])
    edit(text, (t) => deleteRow(t, 0))
    expect(states()).toContainEqual(['a', 'detached'])
  })

  it('comments on an empty cell, and on a range by its corners', () => {
    const { view, shown, text } = setup('a,,c\n1,2,3\n', ',')
    view.startCells(cell(0, 1), cell(0, 1), 'empty')
    view.startCells(cell(1, 2), cell(0, 0), 'range')
    const [range, empty] = [...shown()].sort((x, y) => x.from - y.from)
    expect(empty).toMatchObject({ state: 'attached', quote: '', cells: { from: cell(0, 1) } })
    expect(range).toMatchObject({
      state: 'attached',
      quote: 'a,,c\n1,2,3',
      cells: { from: cell(0, 0), to: cell(1, 2) },
    })
    // Typing into the empty cell stays in it.
    edit(text, (t) => setCell(t, 0, 1, 'b'))
    expect(shown().find((t) => t.cells?.from.col === 1)).toMatchObject({
      state: 'changed',
      live: 'b',
    })
  })

  it('keeps a cell when rows and columns come in beside it', () => {
    // From review: what was inserted at a cell's edges came into its place,
    // and the cell was lost.
    type Change = (t: ReturnType<typeof parse>) => Edit[]
    const cases: Array<
      [string, Change, { row: number; col: number }, { row: number; col: number }]
    > = [
      ['a row above', (t) => insertRow(t, 0), cell(0, 0), cell(1, 0)],
      ['a column before', (t) => insertColumn(t, 0), cell(0, 0), cell(0, 1)],
      ['a column after', (t) => insertColumn(t, 1), cell(0, 0), cell(0, 0)],
      ['a row after the last', (t) => setCell(t, 3, 0, 'new'), cell(1, 0), cell(1, 0)],
      ['values past a short row', (t) => setCell(t, 1, 2, 'x'), cell(1, 0), cell(1, 0)],
    ]
    for (const [name, change, was, now] of cases) {
      const { view, shown, text } = setup('a,b\n1', ',')
      view.startCells(was, was, name)
      edit(text, change)
      expect(only(shown()), name).toMatchObject({ state: 'attached', cells: { from: now } })
    }
  })

  it('comments on a long column, its quote cut to the limit', () => {
    const rows = Array.from({ length: 300 }, (_, i) => `name${i},${i}`).join('\n')
    const { view, shown } = setup(`${rows}\n`, ',')
    expect(view.startCells(cell(0, 1), cell(299, 1), 'the ages')).not.toBeNull()
    const t = only(shown())
    expect(t.quote).toHaveLength(COMMENT_LIMITS.quote)
    expect(t).toMatchObject({ state: 'attached', cells: { from: cell(0, 1), to: cell(299, 1) } })
  })

  it('takes no cell that is not in the table, nor any in a file that is none', () => {
    const { view } = setup('a,b\n1\n', ',')
    expect(view.startCells(cell(1, 1), cell(1, 1), 'past the row')).toBeNull()
    expect(view.startCells(cell(5, 0), cell(5, 0), 'past the table')).toBeNull()
    expect(setup('a,b\n').view.startCells(cell(0, 0), cell(0, 0), 'text')).toBeNull()
  })

  it('shows a cell as gone while the table does not parse', () => {
    const { view, shown, text } = setup('a,b\n', ',')
    view.startCells(cell(0, 1), cell(0, 1), 'b')
    text.insert(0, '"')
    expect(only(shown()).state).toBe('detached')
    text.delete(0, 1)
    expect(only(shown()).state).toBe('attached')
  })
})

describe('comments on cells, from a peer', () => {
  it('places threads over a long run of delimiters in time', () => {
    // From review: a line of delimiters, and threads whose places took in
    // all of it, made each refresh walk the line once per thread.
    const n = 200_000
    const { meta, view, text } = setup(','.repeat(n), ',')
    const b64 = (index: number, assoc: number) =>
      btoa(
        String.fromCharCode(
          ...Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc)),
        ),
      )
    meta.transact(() => {
      for (let i = 0; i < 500; i++) {
        const thread = new Y.Map<unknown>()
        meta.getMap('comments').set(`t${String(i).padStart(4, '0')}`, thread)
        const place =
          i % 2 ? { start: b64(1, -1), end: b64(n, 0) } : { start: b64(n, -1), end: b64(n, 0) }
        thread.set('anchor', { type: 'cells', from: place, to: place })
        thread.set('quote', '')
        thread.set('messages', new Y.Map())
      }
    })
    const began = performance.now()
    view.refresh()
    expect(performance.now() - began).toBeLessThan(1000)
    expect(view.threads.get()).toHaveLength(500)
  })
})

describe('comments on a canvas', () => {
  const canvas = () => {
    const meta = new Y.Doc()
    const content = new Y.Doc()
    addNode(
      content,
      { id: 'n1', type: 'text', x: 0, y: 0, width: 100, height: 50, text: 'Idea' },
      null,
    )
    addNode(
      content,
      { id: 'g1', type: 'group', x: 0, y: 0, width: 300, height: 200, label: 'Plan' },
      null,
    )
    const view = new CommentsView(meta, content, { name: () => 'Ada', delayMs: 0, canvas: true })
    const shown = () => {
      view.refresh()
      return view.threads.get()
    }
    return { content, view, shown }
  }

  it('follows a node: what it shows, and whether it is there', () => {
    const { content, view, shown } = canvas()
    expect(view.startNode('n1', 'Why?')).not.toBeNull()
    expect(only(shown())).toMatchObject({ state: 'attached', quote: 'Idea', node: 'n1', from: -1 })
    const text = textOf(content, 'n1') as Y.Text
    text.insert(4, 's')
    expect(only(shown())).toMatchObject({ state: 'changed', live: 'Ideas', node: 'n1' })
    deleteNodes(content, ['n1'], null)
    expect(only(shown())).toMatchObject({ state: 'detached', node: null })
  })

  it('quotes a group by its label, and takes no node it has not', () => {
    const { view, shown } = canvas()
    expect(view.startOn({ kind: 'node', id: 'g1' }, 'Scope')).not.toBeNull()
    expect(only(shown())).toMatchObject({ state: 'attached', quote: 'Plan' })
    expect(view.startNode('nope', 'Lost')).toBeNull()
  })

  it('places no node in a file that is no canvas', () => {
    const { view, shown, meta } = setup('hello')
    expect(view.startNode('n1', 'Why?')).toBeNull()
    const thread = new Y.Map<unknown>()
    meta.getMap('comments').set('t1', thread)
    thread.set('anchor', { type: 'node', id: 'n1' })
    thread.set('quote', 'Idea')
    thread.set('messages', new Y.Map())
    expect(only(shown()).state).toBe('detached')
  })
})

describe('comments from peers, at the limits', () => {
  it('shows no thread whose anchor kind is no string', () => {
    // From review: String() of an object with no toString threw, and every
    // refresh stopped while the thread was there.
    const { meta, view, shown } = setup('hello')
    const peer = new Y.Doc()
    peer.transact(() => {
      const thread = new Y.Map<unknown>()
      peer.getMap('comments').set('t1', thread)
      thread.set('anchor', { type: { toString: null, valueOf: null } })
      thread.set('quote', 'hello')
      thread.set('messages', new Y.Map())
    })
    const update = Y.encodeStateAsUpdate(peer)
    expect(checkMetaUpdate(meta, update)).toBeNull()
    Y.applyUpdate(meta, update)
    expect(shown()).toEqual([])
    expect(view.start(0, 5, 'still works')).not.toBeNull()
  })

  it('makes no change peers would refuse for its lists', () => {
    // From review: concurrent resolves of one thread from 1,022 clients
    // brought its list near the work every peer allows, and a resolve here
    // went past it, refused by every peer.
    const { meta, view, shown } = setup('hello world')
    const id = view.start(0, 5, 'Why?') as string
    const snapshot = Y.encodeStateAsUpdate(meta)
    for (let i = 0; i < 1022; i++) {
      const fork = new Y.Doc()
      Y.applyUpdate(fork, snapshot)
      ;(fork.getMap('comments').get(id) as Y.Map<unknown>).set('resolved', true)
      const update = Y.encodeStateAsUpdate(fork)
      if (checkMetaUpdate(meta, update) === null) Y.applyUpdate(meta, update)
    }
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(meta))
    const sent: Uint8Array[] = []
    meta.on('update', (u: Uint8Array) => sent.push(u))
    shown()
    view.resolve(id, false)
    view.reply(id, 'and?')
    for (const u of sent) expect(checkMetaUpdate(peer, u)).toBeNull()
  })
})
