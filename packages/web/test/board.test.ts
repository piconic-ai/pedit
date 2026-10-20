// @vitest-environment jsdom
import type { InternalFlowStore } from '@barefootjs/xyflow'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { BoardView } from '../src/board.ts'
import { EDGES, NODES, read, TEXT } from '../src/canvas.ts'
import { JsonPane } from '../src/jsonpane.ts'

beforeAll(() => {
  // jsdom has neither; xyflow measures with the first and the board waits on the second.
  // jsdom lays nothing out; CodeMirror measures text ranges.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const views: BoardView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.element.remove()
})

function docOf(nodes: object[], edges: object[] = []): Y.Doc {
  const doc = new Y.Doc()
  const map = (values: object) => {
    const m = new Y.Map<unknown>()
    for (const [k, v] of Object.entries(values)) {
      if (k === TEXT && typeof v === 'string') {
        const t = new Y.Text()
        t.insert(0, v)
        m.set(k, t)
      } else m.set(k, v)
    }
    return m
  }
  doc.getArray(NODES).push(nodes.map(map))
  doc.getArray(EDGES).push(edges.map(map))
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

const awarenesses = new WeakMap<BoardView, Awareness>()
const awarenessOf = (view: BoardView) => awarenesses.get(view) as Awareness

function setup(doc: Y.Doc) {
  const awareness = new Awareness(doc)
  const view = new BoardView(doc, awareness)
  awarenesses.set(view, awareness)
  document.body.append(view.element)
  views.push(view)
  view.active = true
  return view
}

const tick = () => new Promise((r) => setTimeout(r, 20))

/** The flow's store, with the setters xyflow's own handlers use. */
const storeOf = (view: BoardView) => view.store as unknown as InternalFlowStore

const texts = (view: BoardView) =>
  [...view.element.querySelectorAll('.canvas-body')].map((b) => b.textContent)

/** A change made by someone else, arriving through the room. */
function remote(doc: Y.Doc, fn: () => void) {
  doc.transact(fn, 'remote')
}

function mapOf(doc: Y.Doc, id: string): Y.Map<unknown> {
  for (const item of doc.getArray(NODES)) {
    if (item instanceof Y.Map && item.get('id') === id) return item
  }
  throw new Error(`no node ${id}`)
}

describe('BoardView', () => {
  it('draws the nodes the document holds', async () => {
    const doc = docOf([node('a'), node('b', { type: 'file', file: 'b.md', x: 200 })])
    const view = setup(doc)
    await tick()
    const cards = [...view.element.querySelectorAll('.canvas-card')]
    expect(cards.map((c) => c.className)).toEqual([
      'canvas-card canvas-card--text',
      'canvas-card canvas-card--file',
    ])
    expect(cards.map((c) => c.querySelector('.canvas-body')?.textContent)).toEqual(['a', 'b.md'])
    expect(view.empty.get()).toBe(false)
  })

  it('never draws a field someone set to an object as markup', async () => {
    const doc = docOf([node('a'), node('b', { x: 200 })])
    const view = setup(doc)
    await tick()
    remote(doc, () => mapOf(doc, 'a').set('url', { __bfMarkup: '<b id="injected">x</b>' }))
    await tick()
    expect(view.element.querySelector('#injected')).toBeNull()
    expect(texts(view)).toEqual(['b'])
  })

  it('follows changes others make, and skips what a file cannot hold', async () => {
    const doc = docOf(
      [node('a'), node('b', { x: 200 })],
      [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
    )
    const view = setup(doc)
    await tick()
    expect(view.element.querySelectorAll('.bf-flow__edges .canvas-edge')).toHaveLength(1)

    remote(doc, () => {
      ;(mapOf(doc, 'a').get(TEXT) as Y.Text).insert(1, '!')
      mapOf(doc, 'b').set('width', 300)
      const broken = new Y.Map<unknown>()
      broken.set('id', 'c')
      doc.getArray(NODES).push([broken])
    })
    await tick()
    expect(texts(view)).toEqual(['a!', 'b'])
    expect(view.nodes.get('b')?.get().width).toBe(300)

    remote(doc, () => doc.getArray(NODES).delete(1, 1))
    await tick()
    expect(texts(view)).toEqual(['a!'])
    // The edge to the deleted node goes with it.
    expect(view.element.querySelectorAll('.bf-flow__edges .canvas-edge')).toHaveLength(0)
  })

  it('writes where a drag left the nodes once it ends', async () => {
    const doc = docOf([node('a'), node('b', { x: 200 })])
    const view = setup(doc)
    await tick()
    const store = storeOf(view)
    const flow = view.element.querySelector('.bf-flow') as HTMLElement
    const wrapper = view.element.querySelector('.bf-flow__node[data-id="a"]') as HTMLElement
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }),
      )
    // xyflow's own drag handler, as a person drags node a.
    pointer('pointerdown', wrapper, 100, 100)
    pointer('pointermove', flow, 140.5, 109.25)
    // Someone else moves b meanwhile: a stays under the pointer, b moves.
    remote(doc, () => mapOf(doc, 'b').set('y', 70))
    await tick()
    const positions = () => Object.fromEntries(store.nodes().map((n) => [n.id, n.position]))
    expect(positions()).toEqual({ a: { x: 40.5, y: 9.25 }, b: { x: 200, y: 70 } })
    expect(read(doc).nodes[0]).toMatchObject({ x: 0, y: 0 })

    pointer('pointerup', flow, 140.5, 109.25)
    expect(read(doc).nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ['a', 41, 9],
      ['b', 200, 70],
    ])
    await tick()
    // Released: the next change from the document moves it again.
    remote(doc, () => mapOf(doc, 'a').set('x', 5))
    await tick()
    expect(positions().a).toEqual({ x: 5, y: 9 })
  })

  it('lets a node deleted mid-drag follow the document once restored', async () => {
    const doc = docOf([node('a'), node('b', { x: 200 })])
    const view = setup(doc)
    await tick()
    const store = storeOf(view)
    const flow = view.element.querySelector('.bf-flow') as HTMLElement
    const wrapper = view.element.querySelector('.bf-flow__node[data-id="a"]') as HTMLElement
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }),
      )
    pointer('pointerdown', wrapper, 100, 100)
    pointer('pointermove', flow, 110, 100)
    // Someone else deletes it meanwhile, then undoes the delete.
    const undo = new Y.UndoManager(doc.getArray(NODES), { trackedOrigins: new Set(['remote']) })
    remote(doc, () => doc.getArray(NODES).delete(0, 1))
    await tick()
    pointer('pointerup', flow, 110, 100)
    undo.undo()
    await tick()
    remote(doc, () => mapOf(doc, 'a').set('x', 300))
    await tick()
    expect(store.nodes().find((n) => n.id === 'a')?.position).toEqual({ x: 300, y: 0 })
  })

  it('writes nothing for a click on a node', async () => {
    const doc = docOf([node('a')])
    const view = setup(doc)
    await tick()
    const before = Y.encodeStateAsUpdate(doc)
    const wrapper = view.element.querySelector('.bf-flow__node[data-id="a"]') as HTMLElement
    for (const type of ['pointerdown', 'pointerup']) {
      wrapper.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1 }))
    }
    await tick()
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('adds an edge from side to side, and not from a node to itself', async () => {
    const doc = docOf([node('a'), node('b', { x: 200 })])
    const view = setup(doc)
    await tick()
    view.onConnect({ source: 'a', target: 'b', sourceHandle: 'right', targetHandle: 'left' })
    view.onConnect({ source: 'a', target: 'a', sourceHandle: 'top', targetHandle: 'left' })
    view.onConnect({ source: 'b', target: 'a', sourceHandle: 'nowhere', targetHandle: null })
    const edges = read(doc).edges
    expect(edges.map(({ id: _, ...e }) => e)).toEqual([
      { fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' },
      { fromNode: 'b', toNode: 'a' },
    ])
    expect(edges[0]?.id).toMatch(/^[0-9a-f]{16}$/)
  })

  it('deletes what xyflow deletes, and undoes it', async () => {
    const doc = docOf(
      [node('a'), node('b', { x: 200 })],
      [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
    )
    const view = setup(doc)
    await tick()
    const store = storeOf(view)
    view.onNodesDelete(store.nodes().filter((n) => n.id === 'a'))
    expect(read(doc)).toMatchObject({ nodes: [{ id: 'b' }], edges: [] })
    view.onKey(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    expect(read(doc).nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(read(doc).edges.map((e) => e.id)).toEqual(['ab'])
    view.onEdgesDelete(store.edges())
    expect(read(doc).edges).toEqual([])
    view.onKey(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true }))
    expect(read(doc).edges).toEqual([])
  })

  it('gives xyflow the edges only to select and delete', async () => {
    const doc = docOf(
      [node('a'), node('b', { x: 200 })],
      [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
    )
    const view = setup(doc)
    await tick()
    expect(storeOf(view).edges()).toMatchObject([
      { id: 'ab', source: 'a', target: 'b', hidden: true },
    ])
    // xyflow's own SimpleEdge is not drawn; edges.ts draws instead.
    expect(view.element.querySelectorAll('[data-edge-id]')).toHaveLength(0)
  })

  it('adds a text node where the board is double-clicked, and types in a double-clicked one', async () => {
    const doc = docOf([node('a')])
    const view = setup(doc)
    await tick()
    const pane = view.element.querySelector('.canvas-board') as HTMLElement
    pane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 500, clientY: 300 }))
    await tick()
    const added = read(doc).nodes[1]
    expect(added).toMatchObject({ type: 'text', text: '', width: 250, height: 60 })
    expect(view.editing.get()).toBe(added?.id)

    view.finishEditing()
    const card = view.element.querySelector(
      '.bf-flow__node[data-id="a"] .canvas-card',
    ) as HTMLElement
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(view.editing.get()).toBe('a')
    expect(card.dataset.editing).toBe('')
    expect(card.querySelector('.canvas-editor .cm-content')?.textContent).toBe('a')
    // The caret takes the page's text colour, so it shows on a dark theme too.
    const rules = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n')
    const scope =
      /\.(\S+) \.cm-cursor, \.\1 \.cm-dropCursor \{[^}]*border-left-color: var\(--ink\)/.exec(
        rules,
      )?.[1]
    expect(scope).toBeDefined()
    expect(card.querySelector('.cm-editor')?.classList.contains(scope as string)).toBe(true)
    view.finishEditing()
    expect(card.querySelector('.cm-editor')).toBeNull()
  })

  it('gives xyflow nothing new when only a text changes, and redraws an edge whose label does', async () => {
    const doc = docOf(
      [node('a'), node('b', { x: 200 })],
      [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
    )
    const view = setup(doc)
    await tick()
    const store = storeOf(view)
    const nodes = store.nodes()
    const edges = store.edges()
    remote(doc, () => (mapOf(doc, 'a').get(TEXT) as Y.Text).insert(1, 'bc'))
    await tick()
    expect(texts(view)).toEqual(['abc', 'b'])
    expect(store.nodes()).toBe(nodes)
    expect(store.edges()).toBe(edges)

    remote(doc, () => (doc.getArray(EDGES).get(0) as Y.Map<unknown>).set('label', 'uses'))
    await tick()
    expect(store.edges()).toBe(edges)
    expect(view.element.querySelector('.canvas-edge-label')?.textContent).toBe('uses')
  })

  it('clears its cursor for others once it stops typing in a node', async () => {
    const doc = docOf([node('a')])
    const view = setup(doc)
    await tick()
    view.edit('a')
    expect(view.editing.get()).toBe('a')
    view.finishEditing()
    expect(awarenessOf(view).getLocalState()?.cursor).toBeNull()
  })

  it('shows the JSON beside the board on demand', async () => {
    const doc = docOf([node('a')])
    const json = new JsonPane(doc, { send: () => {} })
    const view = new BoardView(doc, new Awareness(doc), { json })
    document.body.append(view.element)
    views.push(view)
    view.active = true
    await tick()
    const section = view.element.querySelector('.canvas-view') as HTMLElement
    expect(section.hasAttribute('data-json')).toBe(false)
    expect(view.element.querySelector('.canvas-json .canvas-json-editor')).toBe(json.element)
    const toggle = view.element.querySelector('.canvas-json-toggle') as HTMLButtonElement
    toggle.click()
    expect(section.hasAttribute('data-json')).toBe(true)
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    expect(view.element.querySelector('.canvas-json-status')?.textContent).toBe(
      'In step with the canvas.',
    )
    // Clicking the toggle twice quickly is not a double click on the board.
    toggle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await tick()
    expect(read(doc).nodes).toHaveLength(1)
    view.readOnly = true
    expect(json.status.get()).toEqual({ kind: 'closed' })
  })

  it('shares which nodes it has selected, types in and drags', async () => {
    const doc = docOf([node('a'), node('b', { x: 200 })])
    const view = setup(doc)
    await tick()
    const shared = () => awarenessOf(view).getLocalState()?.canvas
    const store = storeOf(view)
    store.setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === 'b' })))
    await tick()
    expect(shared()).toEqual({ selected: ['b'] })

    view.edit('a')
    expect(shared()).toEqual({ selected: ['b'], editing: 'a' })
    view.finishEditing()
    expect(shared()).toEqual({ selected: ['b'] })

    const flow = view.element.querySelector('.bf-flow') as HTMLElement
    const wrapper = view.element.querySelector('.bf-flow__node[data-id="a"]') as HTMLElement
    const pointer = (type: string, target: EventTarget, x: number, y: number) =>
      target.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }),
      )
    pointer('pointerdown', wrapper, 100, 100)
    pointer('pointermove', flow, 130.4, 100)
    await new Promise((r) => requestAnimationFrame(r))
    expect(shared()).toMatchObject({ dragging: { id: 'a', x: 30, y: 0 } })
    // The move reaches the document before the ghost goes, so others never
    // see the node back at its old place in between.
    const order: string[] = []
    doc.on('update', () => order.push('move'))
    awarenessOf(view).on('update', () => order.push('presence'))
    pointer('pointerup', flow, 130.4, 100)
    expect(shared()).not.toHaveProperty('dragging')
    expect(order).toEqual(['move', 'presence'])
  })

  it('shows others on the nodes they are on, and a ghost where they drag', async () => {
    const doc = docOf([node('a'), node('b', { x: 200, width: 80, height: 40 })])
    const view = setup(doc)
    await tick()
    // Someone else, with an awareness of their own, as the room relays it.
    const other = new Awareness(new Y.Doc())
    other.setLocalState({
      user: { name: 'Ann', color: '#1f7a64' },
      canvas: { selected: ['a'], dragging: { id: 'b', x: 300, y: 50 } },
    })
    applyAwarenessUpdate(
      awarenessOf(view),
      encodeAwarenessUpdate(other, [other.clientID]),
      'remote',
    )
    await tick()
    const card = view.element.querySelector(
      '.bf-flow__node[data-id="a"] .canvas-card',
    ) as HTMLElement
    expect(card.hasAttribute('data-peer')).toBe(true)
    expect(card.getAttribute('style')).toContain('--peer-color: #1f7a64')
    expect(card.querySelector('.canvas-peer')?.textContent).toBe('Ann')
    const other2 = view.element.querySelector(
      '.bf-flow__node[data-id="b"] .canvas-card',
    ) as HTMLElement
    expect(other2.hasAttribute('data-peer')).toBe(false)
    const ghost = view.element.querySelector('.canvas-ghost')
    expect(ghost?.querySelector('rect')?.getAttribute('x')).toBe('300')
    expect(ghost?.querySelector('rect')?.getAttribute('width')).toBe('80')
    expect(ghost?.querySelector('text')?.textContent).toBe('Ann')

    // They let go and move on.
    other.setLocalState({ user: { name: 'Ann', color: '#1f7a64' }, canvas: { selected: [] } })
    applyAwarenessUpdate(
      awarenessOf(view),
      encodeAwarenessUpdate(other, [other.clientID]),
      'remote',
    )
    await tick()
    expect(card.hasAttribute('data-peer')).toBe(false)
    expect(view.element.querySelectorAll('.canvas-ghost')).toHaveLength(0)
  })

  it('in a room of several files, shows only the others on this canvas, and not itself', async () => {
    // The canvas is file 2, with a doc of its own; the room's awareness is
    // on the room's doc.
    const doc = docOf([node('a')])
    const room = new Y.Doc()
    const awareness = new Awareness(room)
    awareness.setLocalState({ user: { name: 'Me', color: '#123456' }, file: 2 })
    const view = new BoardView(doc, awareness, {
      here: (s) => (typeof s.file === 'number' ? s.file : 0) === 2,
    })
    document.body.append(view.element)
    views.push(view)
    view.active = true
    await tick()
    // Selecting a node shares it: it must not show as someone else's.
    const store = storeOf(view)
    store.setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === 'a' })))
    await tick()
    expect(awareness.getLocalState()?.canvas).toEqual({ selected: ['a'] })
    const card = view.element.querySelector(
      '.bf-flow__node[data-id="a"] .canvas-card',
    ) as HTMLElement
    expect(card.hasAttribute('data-peer')).toBe(false)

    // Someone on another canvas, whose node is also called "a".
    const elsewhere = new Awareness(new Y.Doc())
    elsewhere.setLocalState({
      user: { name: 'Bo', color: '#1f7a64' },
      file: 3,
      canvas: { selected: ['a'] },
    })
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(elsewhere, [elsewhere.clientID]),
      'remote',
    )
    await tick()
    expect(card.hasAttribute('data-peer')).toBe(false)

    // Someone on this one.
    const here = new Awareness(new Y.Doc())
    here.setLocalState({
      user: { name: 'Ann', color: '#1f7a64' },
      file: 2,
      canvas: { selected: ['a'] },
    })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(here, [here.clientID]), 'remote')
    await tick()
    expect(card.querySelector('.canvas-peer')?.textContent).toBe('Ann')
  })

  it('changes nothing while paused, and can be changed again after', async () => {
    const doc = docOf([node('a')])
    const view = setup(doc)
    await tick()
    view.paused = true
    view.edit('a')
    expect(view.editing.get()).toBeNull()
    expect(storeOf(view).nodesDraggable()).toBe(false)
    view.paused = false
    expect(storeOf(view).nodesDraggable()).toBe(true)
    view.edit('a')
    expect(view.editing.get()).toBe('a')
    view.finishEditing()
  })

  it('changes nothing once the room has closed', async () => {
    const doc = docOf([node('a')])
    const view = setup(doc)
    await tick()
    view.readOnly = true
    const before = Y.encodeStateAsUpdate(doc)
    const pane = view.element.querySelector('.canvas-board') as HTMLElement
    pane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 10, clientY: 10 }))
    view.edit('a')
    expect(view.editing.get()).toBeNull()
    expect(storeOf(view).nodesDraggable()).toBe(false)
    await tick()
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })
})
