// @vitest-environment jsdom
import { undo } from '@codemirror/commands'
import type { CanvasMessage } from '@pedit/protocol'
import { MAX_CANVAS_EDIT_BYTES } from '@pedit/protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { EDGES, NODES, read, TEXT, toJSON } from '../src/canvas.ts'
import { JsonPane } from '../src/jsonpane.ts'

beforeAll(() => {
  // jsdom lays nothing out; CodeMirror measures text ranges.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
})

function docOf(nodes: object[]): Y.Doc {
  const doc = new Y.Doc()
  doc.getArray(NODES).push(
    nodes.map((values) => {
      const m = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(values)) {
        if (k === TEXT && typeof v === 'string') {
          const t = new Y.Text()
          t.insert(0, v)
          m.set(k, t)
        } else m.set(k, v)
      }
      return m
    }),
  )
  doc.getArray(EDGES)
  return doc
}

const node = (id: string, extra: object = {}) => ({
  id,
  type: 'text',
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...extra,
})

function setup(nodes: object[] = [node('a')]) {
  const doc = docOf(nodes)
  const sent: CanvasMessage[] = []
  const pane = new JsonPane(doc, { send: (m) => sent.push(m), delay: 60_000 })
  document.body.append(pane.element)
  const text = () => pane.view.state.doc.toString()
  /** Types over the whole text, as a person pasting would. */
  const type = (next: string) =>
    pane.view.dispatch({
      changes: { from: 0, to: pane.view.state.doc.length, insert: next },
      userEvent: 'input.paste',
    })
  const lastEdit = () => sent.at(-1) as Extract<CanvasMessage, { kind: 'edit' }>
  return { doc, pane, sent, text, type, lastEdit }
}

function mapOf(doc: Y.Doc, id: string): Y.Map<unknown> {
  for (const item of doc.getArray(NODES)) {
    if (item instanceof Y.Map && item.get('id') === id) return item
  }
  throw new Error(`no node ${id}`)
}

describe('JsonPane', () => {
  it('shows the canvas and follows it while nothing is typed', () => {
    const { doc, pane, text } = setup()
    expect(text()).toBe(toJSON(read(doc)))
    pane.view.dispatch({ selection: { anchor: 3 } })
    mapOf(doc, 'a').set('x', 42)
    expect(text()).toBe(toJSON(read(doc)))
    expect(text()).toContain('"x":42')
    // Only the part that changed was replaced, so the cursor stayed.
    expect(pane.view.state.selection.main.head).toBe(3)
    expect(pane.status.get()).toEqual({ kind: 'synced' })
  })

  it('keeps invalid JSON to itself', () => {
    const { pane, sent, type } = setup()
    type('{"nodes":[')
    expect(pane.status.get()).toEqual({ kind: 'editing' })
    pane.check()
    expect(pane.status.get()).toMatchObject({ kind: 'invalid' })
    expect(sent).toEqual([])
  })

  it('sends what it started from and the new text, and stops following meanwhile', () => {
    const { doc, pane, sent, text, type, lastEdit } = setup()
    const base = text()
    const next = base.replace('"x":0', '"x":5')
    type(next)
    pane.check()
    expect(sent).toHaveLength(1)
    expect(lastEdit()).toMatchObject({ kind: 'edit', base, next })
    expect(lastEdit().id).toMatch(/^[0-9a-f]{16}$/)
    expect(pane.status.get()).toEqual({ kind: 'sending' })

    // Someone else changes the canvas: the pane keeps what is being typed.
    mapOf(doc, 'a').set('width', 300)
    expect(text()).toBe(next)
    // Nothing new to send for the same text.
    pane.check()
    expect(sent).toHaveLength(1)
  })

  it('takes the text as agreed once the host applied it, and follows again', () => {
    const { doc, pane, text, type, lastEdit } = setup()
    const next = text().replace('"x":0', '"x":5')
    type(next)
    pane.check()
    // The host applies it, and someone else changed the width meanwhile.
    doc.transact(() => {
      mapOf(doc, 'a').set('x', 5)
      mapOf(doc, 'a').set('width', 300)
    })
    pane.handle({ kind: 'applied', id: lastEdit().id })
    expect(pane.status.get()).toEqual({ kind: 'synced' })
    expect(pane.clean).toBe(true)
    expect(text()).toBe(toJSON(read(doc)))
    expect(text()).toContain('"x":5,"y":0,"width":300')
  })

  it('shows why the host refused, and sends again from the same base', () => {
    const { pane, sent, text, type, lastEdit } = setup()
    const base = text()
    type(base.replace('"x":0', '"x":"zero"'))
    pane.check()
    const reason = 'board.canvas:3:40: nodes[0] (id "a"): "x" must be a number, not a string'
    pane.handle({ kind: 'rejected', id: lastEdit().id, reason })
    expect(pane.status.get()).toEqual({ kind: 'rejected', message: reason })

    type(base.replace('"x":0', '"x":1'))
    pane.check()
    expect(sent).toHaveLength(2)
    expect(lastEdit().base).toBe(base)
  })

  it('sends one edit at a time, the next from what the first made', () => {
    const { pane, sent, text, type, lastEdit } = setup()
    const base = text()
    const first = base.replace('"text":"a"', '"text":"a there"')
    type(first)
    pane.check()
    // Typed on before the answer came: it waits rather than go from the same base.
    const second = base.replace('"text":"a"', '"text":"a there friend"')
    type(second)
    pane.check()
    expect(sent).toHaveLength(1)
    pane.handle({ kind: 'applied', id: lastEdit().id })
    expect(sent).toHaveLength(2)
    expect(lastEdit()).toMatchObject({ base: first, next: second })
    expect(pane.status.get()).toEqual({ kind: 'sending' })
    pane.handle({ kind: 'applied', id: lastEdit().id })
    expect(pane.status.get()).toEqual({ kind: 'synced' })
  })

  it('does not undo what it took in from others', () => {
    const { doc, pane, sent, text } = setup()
    mapOf(doc, 'a').set('x', 42)
    undo(pane.view)
    expect(text()).toContain('"x":42')
    pane.check()
    expect(sent).toEqual([])
  })

  it('sends again what went unanswered once the connection is back, as it was', () => {
    const { pane, sent, text, type, lastEdit } = setup()
    const base = text()
    const next = base.replace('"x":0', '"x":5')
    type(next)
    pane.check()
    const first = lastEdit()
    // The frame, or its answer, was lost while the connection was down. The
    // same id lets the host answer an edit it already applied, not apply it twice.
    pane.reconnected()
    expect(sent).toHaveLength(2)
    expect(lastEdit()).toEqual(first)
    pane.handle({ kind: 'applied', id: first.id })
    expect(pane.status.get()).toEqual({ kind: 'synced' })
    // Nothing waiting: a reconnect sends nothing.
    pane.reconnected()
    expect(sent).toHaveLength(2)
  })

  it('takes in what changed meanwhile once the text is back to the base', () => {
    const { doc, pane, text, type, lastEdit } = setup()
    const base = text()
    type(base.replace('"x":0', '"x":"zero"'))
    pane.check()
    pane.handle({ kind: 'rejected', id: lastEdit().id, reason: 'no' })
    mapOf(doc, 'a').set('width', 300)
    type(base)
    pane.check()
    expect(pane.status.get()).toEqual({ kind: 'synced' })
    expect(text()).toBe(toJSON(read(doc)))
    expect(text()).toContain('"width":300')
  })

  it('ignores answers to edits it did not send', () => {
    const { pane } = setup()
    pane.handle({ kind: 'rejected', id: 'someone-else', reason: 'no' })
    pane.handle({ kind: 'edit', id: 'x', base: '', next: '' })
    expect(pane.status.get()).toEqual({ kind: 'synced' })
  })

  it('does not send what would not fit in one frame', () => {
    const { pane, sent, type } = setup()
    type(JSON.stringify({ nodes: [], pad: 'x'.repeat(MAX_CANVAS_EDIT_BYTES) }))
    pane.check()
    expect(pane.status.get()).toEqual({ kind: 'too-large' })
    expect(sent).toEqual([])
  })

  it('is read-only while the host is away, and not once it is back', () => {
    const { pane } = setup()
    pane.readOnly = true
    expect(pane.view.state.readOnly).toBe(true)
    pane.readOnly = false
    expect(pane.view.state.readOnly).toBe(false)
    // Closed for good, it stays read-only.
    pane.close()
    pane.readOnly = false
    expect(pane.view.state.readOnly).toBe(true)
  })

  it('cannot be edited once the room has closed', () => {
    const { pane, sent, type } = setup()
    pane.close()
    expect(pane.view.state.readOnly).toBe(true)
    type('{}')
    pane.check()
    expect(sent).toEqual([])
    expect(pane.status.get()).toEqual({ kind: 'closed' })
  })
})
