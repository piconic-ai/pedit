import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addEdge,
  addNode,
  type Canvas,
  deleteEdges,
  deleteNodes,
  EDGES,
  moveNodes,
  NODES,
  newId,
  read,
  resizeNode,
  TEXT,
  textOf,
  toJSON,
} from '../src/canvas.ts'

/** The sample Obsidian wrote, which the Go side tests too. */
const sample = readFileSync(resolve(import.meta.dirname, '../../testdata/obsidian.canvas'), 'utf8')

/** A document holding a canvas as the host shares it (internal/canvas.Load). */
function docOf(canvas: { nodes: object[]; edges: object[] }): Y.Doc {
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
  doc.getArray(NODES).push(canvas.nodes.map(map))
  doc.getArray(EDGES).push(canvas.edges.map(map))
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

const ids = (items: readonly { id: string }[]) => items.map((i) => i.id)

describe('read', () => {
  it('reads what the host shared, text out of its Y.Text', () => {
    const canvas = read(docOf(JSON.parse(sample)))
    expect(canvas.nodes).toHaveLength(5)
    expect(canvas.nodes[3]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Learn more'),
    })
    expect(canvas.edges).toHaveLength(1)
  })

  it('skips what a file cannot hold, by the rules of internal/canvas', () => {
    const canvas = read(
      docOf({
        nodes: [
          node('a'),
          node('a'), // the same id again
          node('b', { x: '0' }),
          node('c', { text: undefined }),
          { id: 'd', type: 'file', x: 0, y: 0, width: 1, height: 1 },
          { id: 'e', type: 'group', x: 0, y: 0, width: 1, height: 1, backgroundStyle: 'tile' },
          { id: 'f', type: 'group', x: 0, y: 0, width: 1, height: 1, label: 'kept' },
          { id: 'g', type: 'future', x: 0, y: 0, width: 1, height: 1 },
          node('h', { color: 3 }),
          // A field the spec defines is a string whatever the type, as in Go.
          node('i', { label: 7 }),
          node('j', { url: { __bfMarkup: '<style>body{display:none}</style>' } }),
          { id: 'k', type: 'constructor', x: 0, y: 0, width: 1, height: 1 },
          node('l', { backgroundStyle: 'tile' }),
        ],
        edges: [
          { id: 'e1', fromNode: 'a', toNode: 'f' },
          { id: 'e1', fromNode: 'a', toNode: 'f' },
          { id: 'e2', fromNode: 'a', toNode: 'b' }, // b was skipped
          { id: 'e3', fromNode: 'a', toNode: 'f', toSide: 'middle' },
          { id: 'e4', fromNode: 'a', toNode: 'g', toEnd: 'none', label: 'x' },
        ],
      }),
    )
    expect(ids(canvas.nodes)).toEqual(['a', 'f', 'g', 'k', 'l'])
    expect(ids(canvas.edges)).toEqual(['e1', 'e4'])
  })

  it('reads anything but a Y.Map as nothing', () => {
    const doc = new Y.Doc()
    doc.getArray(NODES).push(['text', 3, { id: 'plain object' }])
    expect(read(doc)).toEqual({ nodes: [], edges: [] })
  })
})

describe('toJSON', () => {
  it('writes a canvas as Obsidian does', () => {
    expect(toJSON(read(docOf(JSON.parse(sample))))).toBe(sample)
  })

  it('writes empty lists and fields in Obsidian order', () => {
    const canvas: Canvas = {
      nodes: [{ height: 2, width: 1, y: 0, x: 0, text: 'a"b', type: 'text', id: 'n', color: '1' }],
      edges: [],
    }
    expect(toJSON(canvas)).toBe(
      '{\n\t"nodes":[\n\t\t{"id":"n","type":"text","text":"a\\"b","x":0,"y":0,"width":1,"height":2,"color":"1"}\n\t],\n\t"edges":[]\n}',
    )
  })
})

describe('edits', () => {
  it('moves and resizes in whole pixels', () => {
    const doc = docOf({ nodes: [node('a'), node('b')], edges: [] })
    moveNodes(
      doc,
      [
        { id: 'a', x: 10.4, y: -3.6 },
        { id: 'zz', x: 1, y: 1 },
      ],
      null,
    )
    resizeNode(doc, 'b', { x: 1, y: 2, width: 30.5, height: 40 }, null)
    expect(read(doc).nodes).toMatchObject([
      { id: 'a', x: 10, y: -4 },
      { id: 'b', x: 1, y: 2, width: 31, height: 40 },
    ])
  })

  it('adds a text node with a Y.Text, and an edge', () => {
    const doc = docOf({ nodes: [node('a')], edges: [] })
    addNode(doc, node('b', { text: 'hi', x: 1.5 }), null)
    addEdge(doc, { id: 'e', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }, null)
    expect(textOf(doc, 'b')?.toString()).toBe('hi')
    expect(read(doc)).toMatchObject({
      nodes: [{ id: 'a' }, { id: 'b', x: 2 }],
      edges: [{ id: 'e', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' }],
    })
    // Undefined fields are left out, not stored.
    expect([...(doc.getArray(EDGES).get(0) as Y.Map<unknown>).keys()]).not.toContain('label')
  })

  it('deletes nodes with the edges that join them', () => {
    const doc = docOf({
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { id: 'ab', fromNode: 'a', toNode: 'b' },
        { id: 'bc', fromNode: 'b', toNode: 'c' },
        { id: 'ca', fromNode: 'c', toNode: 'a' },
      ],
    })
    deleteNodes(doc, ['b'], null)
    expect(ids(read(doc).nodes)).toEqual(['a', 'c'])
    expect(ids(read(doc).edges)).toEqual(['ca'])
    deleteEdges(doc, ['ca'], null)
    expect(read(doc).edges).toEqual([])
  })

  it('undoes an edit as one step', () => {
    const doc = docOf({
      nodes: [node('a'), node('b')],
      edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
    })
    const origin = Symbol('mine')
    const undo = new Y.UndoManager([doc.getArray(NODES), doc.getArray(EDGES)], {
      trackedOrigins: new Set([origin]),
    })
    deleteNodes(doc, ['a'], origin)
    expect(read(doc).edges).toEqual([])
    undo.undo()
    expect(ids(read(doc).nodes)).toEqual(['a', 'b'])
    expect(ids(read(doc).edges)).toEqual(['ab'])
  })

  it('makes ids like Obsidian', () => {
    expect(newId()).toMatch(/^[0-9a-f]{16}$/)
  })
})
