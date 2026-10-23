import * as Y from 'yjs'

/**
 * A JSON Canvas (https://jsoncanvas.org) as the host shares it: nodes and
 * edges are Y.Maps in Y.Arrays, and a text node's text is a Y.Text, so
 * co-editing cannot break the file. internal/canvas in Go writes and reads
 * the same shape; keep the names and the rules in sync with it.
 */

/** The shared types, as internal/canvas/doc.go names them. */
export const NODES = 'nodes'
export const EDGES = 'edges'
export const TEXT = 'text'

export type Side = 'top' | 'right' | 'bottom' | 'left'
export type End = 'none' | 'arrow'

export const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left']
const ENDS: readonly string[] = ['none', 'arrow']
const BACKGROUND_STYLES: readonly string[] = ['cover', 'ratio', 'repeat']
// The string fields of a node, and the one each type requires.
const STRING_FIELDS = ['text', 'file', 'subpath', 'url', 'label', 'background', 'color'] as const
const REQUIRED = new Map([
  ['text', 'text'],
  ['file', 'file'],
  ['link', 'url'],
])

export interface CanvasNode {
  id: string
  /** text, file, link or group; any other type is drawn as a plain box. */
  type: string
  x: number
  y: number
  width: number
  height: number
  color?: string
  text?: string
  file?: string
  subpath?: string
  url?: string
  label?: string
}

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: Side
  toSide?: Side
  fromEnd?: End
  toEnd?: End
  color?: string
  label?: string
}

export interface Canvas {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

type Values = Record<string, unknown>

/** An item's fields as plain values, its text read out of its Y.Text. */
function valuesOf(item: unknown): Values | null {
  if (!(item instanceof Y.Map)) return null
  const out: Values = {}
  for (const [k, v] of item.entries()) out[k] = v instanceof Y.AbstractType ? v.toJSON() : v
  return out
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A string field that is absent, or a string (among `allowed` when given). */
function optionalString(values: Values, key: string, allowed?: readonly string[]): boolean {
  const v = values[key]
  if (v === undefined) return true
  return typeof v === 'string' && (!allowed || allowed.includes(v))
}

/**
 * Whether a node can be drawn and written to a file, by the rules of
 * checkNode in internal/canvas/validate.go.
 */
function isNode(v: Values, ids: Set<string>): boolean {
  if (typeof v.id !== 'string' || v.id === '' || ids.has(v.id)) return false
  if (typeof v.type !== 'string') return false
  if (![v.x, v.y, v.width, v.height].every(isNumber)) return false
  // The fields the spec defines are strings on every node, whatever its type:
  // a peer can set any of them, and the card shows them as text.
  const required = REQUIRED.get(v.type)
  if (required && v[required] === undefined) return false
  const styles = v.type === 'group' ? BACKGROUND_STYLES : undefined
  return (
    STRING_FIELDS.every((key) => optionalString(v, key)) &&
    optionalString(v, 'backgroundStyle', styles)
  )
}

/** Likewise for an edge, by checkEdge's rules. */
function isEdge(v: Values, ids: Set<string>, nodes: Set<string>): boolean {
  if (typeof v.id !== 'string' || v.id === '' || ids.has(v.id)) return false
  if (typeof v.fromNode !== 'string' || !nodes.has(v.fromNode)) return false
  if (typeof v.toNode !== 'string' || !nodes.has(v.toNode)) return false
  return (
    optionalString(v, 'fromSide', SIDES) &&
    optionalString(v, 'toSide', SIDES) &&
    optionalString(v, 'fromEnd', ENDS) &&
    optionalString(v, 'toEnd', ENDS) &&
    optionalString(v, 'color') &&
    optionalString(v, 'label')
  )
}

/**
 * The canvas in a document. Like Read in internal/canvas/doc.go, it skips
 * what a file could not hold: an edge to a node deleted meanwhile, an item a
 * newer or broken peer left incomplete, a second item with the same id. So
 * the page shows what the host writes.
 */
export function read(doc: Y.Doc): Canvas {
  const nodes: CanvasNode[] = []
  const nodeIds = new Set<string>()
  for (const item of doc.getArray(NODES)) {
    const v = valuesOf(item)
    if (v && isNode(v, nodeIds)) {
      nodeIds.add(v.id as string)
      nodes.push(v as unknown as CanvasNode)
    }
  }
  const edges: CanvasEdge[] = []
  const edgeIds = new Set<string>()
  for (const item of doc.getArray(EDGES)) {
    const v = valuesOf(item)
    if (v && isEdge(v, edgeIds, nodeIds)) {
      edgeIds.add(v.id as string)
      edges.push(v as unknown as CanvasEdge)
    }
  }
  return { nodes, edges }
}

/** A new id in the form Obsidian uses: 16 hex digits. */
/**
 * What a node shows: a text node's text, a file's path, a link's address, a
 * group's label, else its type. A comment on the node quotes it.
 */
export function nodeText(n: CanvasNode): string {
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  switch (n.type) {
    case 'text':
      return text(n.text)
    case 'file':
      return text(n.file) + text(n.subpath)
    case 'link':
      return text(n.url)
    case 'group':
      return text(n.label)
    default:
      return text(n.type)
  }
}

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The Y.Map of the item with `id` in a list, and where it is. */
function find(list: Y.Array<unknown>, id: string): { map: Y.Map<unknown>; index: number } | null {
  let index = 0
  for (const item of list) {
    if (item instanceof Y.Map && item.get('id') === id) return { map: item, index }
    index++
  }
  return null
}

/** The Y.Text of a text node, to edit it in place. */
export function textOf(doc: Y.Doc, id: string): Y.Text | null {
  const text = find(doc.getArray(NODES), id)?.map.get(TEXT)
  return text instanceof Y.Text ? text : null
}

/** Positions and sizes are whole pixels, as Obsidian writes them. */
const whole = (n: number) => Math.round(n)

/** Moves nodes; unknown ids are skipped. */
export function moveNodes(
  doc: Y.Doc,
  moves: readonly { id: string; x: number; y: number }[],
  origin: unknown,
): void {
  const nodes = doc.getArray(NODES)
  doc.transact(() => {
    for (const m of moves) {
      const found = find(nodes, m.id)
      if (!found) continue
      if (found.map.get('x') !== whole(m.x)) found.map.set('x', whole(m.x))
      if (found.map.get('y') !== whole(m.y)) found.map.set('y', whole(m.y))
    }
  }, origin)
}

/** Moves and resizes a node at once: resizing from the top or left moves it too. */
export function resizeNode(
  doc: Y.Doc,
  id: string,
  box: { x: number; y: number; width: number; height: number },
  origin: unknown,
): void {
  const found = find(doc.getArray(NODES), id)
  if (!found) return
  doc.transact(() => {
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      const v = whole(box[key])
      if (found.map.get(key) !== v) found.map.set(key, v)
    }
  }, origin)
}

/** Adds a node on top of the others; a text node gets its text as a Y.Text. */
export function addNode(doc: Y.Doc, node: CanvasNode, origin: unknown): void {
  const map = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(node)) {
    if (v === undefined) continue
    if (k === TEXT && typeof v === 'string') {
      const text = new Y.Text()
      text.insert(0, v)
      map.set(k, text)
    } else {
      map.set(k, typeof v === 'number' ? whole(v) : v)
    }
  }
  doc.transact(() => doc.getArray(NODES).push([map]), origin)
}

export function addEdge(doc: Y.Doc, edge: CanvasEdge, origin: unknown): void {
  const map = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(edge)) if (v !== undefined) map.set(k, v)
  doc.transact(() => doc.getArray(EDGES).push([map]), origin)
}

function deleteFrom(list: Y.Array<unknown>, ids: ReadonlySet<string>): void {
  // From the end, so earlier indexes stay valid.
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list.get(i)
    if (item instanceof Y.Map && ids.has(item.get('id') as string)) list.delete(i, 1)
  }
}

/** Deletes nodes and the edges that join them, as Obsidian does. */
export function deleteNodes(doc: Y.Doc, ids: readonly string[], origin: unknown): void {
  const gone = new Set(ids)
  const edges = new Set<string>()
  for (const item of doc.getArray(EDGES)) {
    if (!(item instanceof Y.Map)) continue
    if (gone.has(item.get('fromNode') as string) || gone.has(item.get('toNode') as string)) {
      edges.add(item.get('id') as string)
    }
  }
  doc.transact(() => {
    deleteFrom(doc.getArray(NODES), gone)
    deleteFrom(doc.getArray(EDGES), edges)
  }, origin)
}

export function deleteEdges(doc: Y.Doc, ids: readonly string[], origin: unknown): void {
  doc.transact(() => deleteFrom(doc.getArray(EDGES), new Set(ids)), origin)
}

/** The order Obsidian writes fields in; others follow, sorted. */
const NODE_KEYS = [
  'id',
  'type',
  'text',
  'file',
  'subpath',
  'url',
  'x',
  'y',
  'width',
  'height',
  'color',
  'label',
]
const EDGE_KEYS = [
  'id',
  'fromNode',
  'fromSide',
  'fromEnd',
  'toNode',
  'toSide',
  'toEnd',
  'color',
  'label',
]

function ordered(item: object, order: readonly string[]): string {
  const values = item as Values
  const keys = [
    ...order.filter((k) => values[k] !== undefined),
    ...Object.keys(values)
      .filter((k) => !order.includes(k) && values[k] !== undefined)
      .sort(),
  ]
  return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(values[k])}`).join(',')}}`
}

/**
 * The canvas as JSON Canvas text, laid out as Obsidian writes it: tabs, one
 * node or edge per line. The same as the host writes a new file.
 */
export function toJSON(canvas: Canvas): string {
  const list = (items: readonly object[], order: readonly string[]) =>
    items.length === 0
      ? '[]'
      : `[\n${items.map((i) => `\t\t${ordered(i, order)}`).join(',\n')}\n\t]`
  return `{\n\t"nodes":${list(canvas.nodes, NODE_KEYS)},\n\t"edges":${list(canvas.edges, EDGE_KEYS)}\n}`
}
