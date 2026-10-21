import { createContext, createEffect, createRoot, untrack } from '@barefootjs/client'
import { render } from '@barefootjs/client/runtime'
import type { EdgeBase, FlowStore, NodeBase } from '@barefootjs/xyflow'
import { initNodeResizer, setupNodeSelection } from '@barefootjs/xyflow'
import { defaultKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorView, keymap } from '@codemirror/view'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  addEdge,
  addNode,
  type Canvas,
  type CanvasNode,
  deleteEdges,
  deleteNodes,
  EDGES,
  moveNodes,
  NODES,
  newId,
  read,
  resizeNode,
  SIDES,
  type Side,
  textOf,
} from './canvas.ts'
import { type Box, EdgeLayer, shapesOf } from './edges.ts'
import type { JsonPane } from './jsonpane.ts'
import { type NodePeers, type Presence, peersOf, sameNodePeers, samePresence } from './presence.ts'
import { Store } from './store.ts'
import './components/CanvasBoard.tsx'

/**
 * The board, for the cards xyflow draws: they get only their node, so they
 * find the view through this context, which CanvasBoard provides.
 */
export const BoardContext = createContext<BoardView | null>(null)

/**
 * The node editor's colours, from the page's: it has no editor theme, and
 * CodeMirror's defaults are for a light page (a black caret, a pale
 * selection), which vanish on a dark one. It keeps the card's font too, so
 * the text does not change face while it is typed in.
 */
const nodeEditorTheme = EditorView.theme({
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: 'inherit' },
  '.cm-content': { caretColor: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { background: 'color-mix(in srgb, var(--accent) 35%, transparent)' },
})

/** Marks the board's own edits, so the undo manager tracks them. */
const BOARD_ORIGIN = Symbol('board')

/** A new text node's size, as Obsidian makes them. */
const NEW_NODE = { width: 250, height: 60 }
const MIN_SIZE = { width: 40, height: 30 }
/** How far out the board zooms; CanvasBoard gives xyflow the same. */
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4

/** The box around every node, or null for none. */
export function boundsOf(
  nodes: readonly CanvasNode[],
): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null
  const left = Math.min(...nodes.map((n) => n.x))
  const top = Math.min(...nodes.map((n) => n.y))
  const right = Math.max(...nodes.map((n) => n.x + n.width))
  const bottom = Math.max(...nodes.map((n) => n.y + n.height))
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

/** What xyflow's connection handler reports. */
export interface Connection {
  source: string
  target: string
  sourceHandle: string | null
  targetHandle: string | null
}

const asSide = (handle: string | null): Side | undefined =>
  SIDES.includes(handle as Side) ? (handle as Side) : undefined

/** Whether two lists hold the very same items, in order. */
function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** Two nodes that look the same, so a publish can keep xyflow's copy. */
function sameNode(a: CanvasNode, b: CanvasNode): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof CanvasNode>
  for (const k of keys) if (a[k] !== b[k]) return false
  return true
}

/**
 * A JSON Canvas as a board to edit by hand: move, resize, connect, type in
 * text nodes, add and delete. It keeps no content of its own: it draws what
 * the shared document holds (canvas.ts) and writes every change back there,
 * where the host saves it to the file.
 *
 * This class keeps the state and publishes it as stores; CanvasBoard.tsx
 * draws it with @barefootjs/xyflow and hands the flow's events back here.
 * xyflow keeps positions while something is dragged; the document gets them
 * when the drag ends, so others see a move once, not every frame.
 */
export class BoardView {
  readonly element: HTMLElement
  /** Each node's fields, by id, for its body to draw. */
  readonly nodes = new Map<string, Store<CanvasNode>>()
  /** The ids of the nodes, in stacking order. */
  readonly nodeIds = new Store<readonly string[]>([])
  /** The text node being typed in. */
  readonly editing = new Store<string | null>(null)
  /** Whether the canvas has nothing in it yet, for the hint. */
  readonly empty = new Store(true)
  /** The canvas as JSON, beside the board while `showJson` is on. */
  readonly json: JsonPane | null
  /**
   * Whether the JSON shows. A back door for fixes and bulk edits, so it is
   * off whenever the page opens, and not remembered.
   */
  readonly showJson = new Store(false)
  /** Others on each node, by id: who has it selected or is typing in it. */
  readonly peers = new Store<Readonly<Record<string, NodePeers>>>({})
  /** The ids of the nodes selected here. */
  readonly selected = new Store<readonly string[]>([])
  /** The nodes open comments are on. */
  readonly commented = new Store<ReadonlySet<string>>(new Set())
  /** What this browser shares of where it is on the canvas. */
  #presence: Presence = { selected: [] }
  #layer: EdgeLayer | null = null
  /** The drag position waiting for the next frame to be shared. */
  #dragShare: { id: string; x: number; y: number } | null = null
  #dragFrame = 0
  #doc: Y.Doc
  #awareness: Awareness
  #here: (state: Record<string, unknown>) => boolean
  #undo: Y.UndoManager
  #store: FlowStore | null = null
  #canvas: Canvas = { nodes: [], edges: [] }
  #active = false
  #fitted = false
  #dragging = new Set<string>()
  #resizers = new Map<string, () => void>()
  #editor: EditorView | null = null
  #scheduled = false
  // Read-only once the room has closed, or while the host is away.
  #readOnly = false
  #closed = false
  #paused = false
  /** Bumped when the edges change in a way only edges.ts draws. */
  #edgesChanged = new Store(0)
  #drawnEdges = ''

  constructor(
    doc: Y.Doc,
    awareness: Awareness,
    options: {
      json?: JsonPane
      /** Whose presence is on this canvas, in a room that shares several files. */
      here?: (state: Record<string, unknown>) => boolean
    } = {},
  ) {
    this.#doc = doc
    this.#awareness = awareness
    this.#here = options.here ?? (() => true)
    this.json = options.json ?? null
    const scope = [doc.getArray(NODES), doc.getArray(EDGES)]
    // Undo only this browser's edits, not everyone's; typing in a text node
    // adds the editor's own origin.
    this.#undo = new Y.UndoManager(scope, { trackedOrigins: new Set([BOARD_ORIGIN]) })
    this.element = document.createElement('div')
    this.element.className = 'canvas-slot'
    render(this.element, 'CanvasBoard', { view: this })
    for (const list of scope) list.observeDeep(() => this.#schedule())
    awareness.on('change', () => this.#paintPeers())
  }

  /** Shares where this browser is on the canvas, when that changed. */
  #share(next: Presence): void {
    if (samePresence(this.#presence, next)) return
    this.#presence = next
    this.#awareness.setLocalStateField('canvas', {
      selected: next.selected,
      ...(next.editing && { editing: next.editing }),
      ...(next.dragging && { dragging: next.dragging }),
    })
  }

  /** Draws where the others are: outlines on their nodes, ghosts where they drag. */
  #paintPeers(): void {
    const states = new Map(
      [...this.#awareness.getStates()].filter(([, s]) => this.#here(s as Record<string, unknown>)),
    )
    // Self by the awareness: a file of a room that shares several has a doc
    // of its own, with another client id.
    const { nodes, ghosts } = peersOf(states, this.#awareness.clientID)
    if (
      !sameNodePeers(
        untrack(() => this.peers.get()),
        nodes,
      )
    )
      this.peers.set(nodes)
    this.#layer?.drawGhosts(
      ghosts.flatMap((g) => {
        const n = this.nodes.get(g.id)
        if (!n) return []
        const { width, height } = untrack(() => n.get())
        return [{ ...g, width, height }]
      }),
    )
  }

  get active(): boolean {
    return this.#active
  }

  set active(on: boolean) {
    this.#active = on
    if (!on) this.finishEditing()
    if (on) this.#publish()
  }

  /** The canvas as it was last drawn. */
  get canvas(): Canvas {
    return this.#canvas
  }

  get store(): FlowStore | null {
    return this.#store
  }

  /** Once the room has closed: the board shows the canvas, and nothing changes it. */
  set readOnly(on: boolean) {
    this.#closed = on
    if (on) this.json?.close()
    this.#lock()
  }

  /** While the host is away: nothing changes the board until it is back. */
  set paused(on: boolean) {
    this.#paused = on
    if (this.json && !this.#closed) this.json.readOnly = on
    this.#lock()
  }

  #lock(): void {
    this.#readOnly = this.#closed || this.#paused
    if (this.#readOnly) this.finishEditing()
    this.#store?.setNodesDraggable(!this.#readOnly)
    this.#store?.setNodesConnectable(!this.#readOnly)
  }

  toggleJson(): void {
    this.showJson.set(!untrack(() => this.showJson.get()))
  }

  /** Where CanvasBoard puts the JSON pane's editor. */
  mountJson(host: HTMLElement): void {
    if (this.json) host.prepend(this.json.element)
  }

  /** Called by the flow once it exists. */
  onInit(store: FlowStore): void {
    this.#store = store
    if (this.#readOnly) this.#lock()
    this.#publish()
    this.#drawEdges(store)
  }

  /**
   * Draws the edges (edges.ts) into xyflow's edge layer, again whenever a
   * node moves or resizes, the edges change, or one is selected.
   */
  #drawEdges(store: FlowStore): void {
    const svg = store.domNode()?.querySelector<SVGSVGElement>('.bf-flow__edges')
    if (!svg) {
      requestAnimationFrame(() => this.#drawEdges(store))
      return
    }
    const layer = new EdgeLayer(svg, (id) => this.#selectEdge(id))
    this.#layer = layer
    this.#paintPeers()
    createRoot(() => {
      // Shares which nodes are selected here, as they change.
      createEffect(() => {
        const selected = store
          .nodes()
          .filter((n) => n.selected)
          .map((n) => n.id)
        untrack(() => {
          this.#share({ ...this.#presence, selected })
          if (!sameItems(selected, this.selected.get())) this.selected.set(selected)
        })
      })
      createEffect(() => {
        this.#edgesChanged.get()
        store.positionEpoch()
        const lookup = store.nodeLookup()
        const selected = new Set(
          store
            .edges()
            .filter((e) => e.selected)
            .map((e) => e.id),
        )
        const boxes = new Map<string, Box>()
        for (const [id, node] of lookup) {
          // Sizes from the node's store, which follows a resize as it happens.
          const n = this.nodes.get(id)
          const size = n ? untrack(() => n.get()) : null
          boxes.set(id, {
            ...node.internals.positionAbsolute,
            width: size?.width ?? node.measured.width ?? 0,
            height: size?.height ?? node.measured.height ?? 0,
          })
        }
        layer.draw(shapesOf(this.#canvas.edges, boxes, selected))
      })
    })
  }

  /** Selects one node, as a click would: to show a comment's place. */
  selectNode(id: string): void {
    const store = this.#store
    if (!store) return
    store.domNode()?.focus()
    store.unselectNodesAndEdges()
    store.setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, selected: true } : n)))
  }

  #selectEdge(id: string): void {
    const store = this.#store
    if (!store) return
    // Focused, so Delete reaches xyflow's keyboard handler.
    store.domNode()?.focus()
    store.unselectNodesAndEdges()
    store.setEdges((prev) => prev.map((e) => (e.id === id ? { ...e, selected: true } : e)))
  }

  /** Publishes the document's canvas once per task, however many changes came in. */
  #schedule(): void {
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      if (this.#active) this.#publish()
    })
  }

  #publish(): void {
    const canvas = read(this.#doc)
    this.#canvas = canvas
    const ids = canvas.nodes.map((n) => n.id)
    for (const n of canvas.nodes) {
      const store = this.nodes.get(n.id)
      if (!store) this.nodes.set(n.id, new Store(n))
      else if (
        !sameNode(
          untrack(() => store.get()),
          n,
        )
      )
        store.set(n)
    }
    for (const id of [...this.nodes.keys()]) {
      if (!ids.includes(id)) {
        this.nodes.delete(id)
        // Deleted mid-drag or mid-resize by someone else: no stop will come,
        // and a node restored under the same id must follow the document.
        this.#dragging.delete(id)
        this.#resizers.get(id)?.()
        this.#resizers.delete(id)
      }
    }
    const shown = untrack(() => this.nodeIds.get())
    if (shown.length !== ids.length || shown.some((id, i) => id !== ids[i])) this.nodeIds.set(ids)
    this.empty.set(canvas.nodes.length === 0)
    const editing = untrack(() => this.editing.get())
    if (editing && !ids.includes(editing)) this.finishEditing()

    const store = this.#store
    if (!store) return
    const prev = new Map(untrack(store.nodes).map((n) => [n.id, n]))
    const nodes = canvas.nodes.map((n): NodeBase => {
      const p = prev.get(n.id)
      // A node being dragged or resized here stays where the pointer has it.
      const position = p && this.#dragging.has(n.id) ? p.position : { x: n.x, y: n.y }
      if (
        p &&
        p.position.x === position.x &&
        p.position.y === position.y &&
        p.width === n.width &&
        p.height === n.height &&
        p.type === n.type
      ) {
        return p
      }
      return {
        id: n.id,
        type: n.type,
        position,
        width: n.width,
        height: n.height,
        data: {},
        selected: p?.selected,
        // Groups sit behind the nodes in them.
        zIndex: n.type === 'group' ? -1 : 0,
      }
    })
    // Typing in a text node changes no node xyflow has: then it gets nothing,
    // so a keystroke does not rebuild its lookups or redraw every edge.
    if (!sameItems(nodes, untrack(store.nodes))) store.setNodes(nodes)

    const current = untrack(store.edges)
    const selected = new Set(current.filter((e) => e.selected).map((e) => e.id))
    // xyflow keeps the edges for selecting and deleting; edges.ts draws them.
    const edges = canvas.edges.map(
      (e): EdgeBase => ({
        id: e.id,
        source: e.fromNode,
        target: e.toNode,
        hidden: true,
        selected: selected.has(e.id),
      }),
    )
    const unchanged =
      edges.length === current.length &&
      edges.every((e, i) => {
        const c = current[i]
        return c && c.id === e.id && c.source === e.source && c.target === e.target
      })
    if (!unchanged) store.setEdges(edges)
    // What xyflow does not know about an edge (sides, ends, label, colour)
    // redraws the edge layer by itself.
    const drawn = JSON.stringify(canvas.edges)
    if (drawn !== this.#drawnEdges) {
      this.#drawnEdges = drawn
      this.#edgesChanged.set(untrack(() => this.#edgesChanged.get()) + 1)
    }
    if (!this.#fitted && canvas.nodes.length > 0) {
      this.#fitted = true
      this.#fit()
    }
  }

  /**
   * Shows the whole canvas. The bounds come from the document, which knows
   * every node's size, rather than xyflow's fitView, which needs the nodes
   * measured first and gives NaN before.
   */
  #fit(): void {
    const store = this.#store
    const pane = store?.domNode()
    const panZoom = store?.panZoom()
    const rect = pane?.getBoundingClientRect()
    if (!store || !panZoom || !rect || rect.width === 0 || rect.height === 0) {
      // Laid out on a later frame.
      requestAnimationFrame(() => this.#fit())
      return
    }
    const bounds = boundsOf(this.#canvas.nodes)
    if (!bounds) return
    const padding = 0.1
    const zoom = Math.min(
      1,
      Math.max(
        MIN_ZOOM,
        Math.min(
          rect.width / (bounds.width * (1 + 2 * padding)),
          rect.height / (bounds.height * (1 + 2 * padding)),
        ),
      ),
    )
    void panZoom.setViewport({
      x: rect.width / 2 - (bounds.x + bounds.width / 2) * zoom,
      y: rect.height / 2 - (bounds.y + bounds.height / 2) * zoom,
      zoom,
    })
  }

  onNodeDragStart(nodes: readonly NodeBase[]): void {
    for (const n of nodes) this.#dragging.add(n.id)
  }

  /**
   * Shares where a drag has the node, at most once a frame, so others see
   * it move as a ghost. The document gets the move when the drag ends.
   */
  onNodeDrag(nodes: readonly NodeBase[]): void {
    const n = nodes[0]
    if (!n) return
    this.#dragShare = { id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) }
    this.#dragFrame ||= requestAnimationFrame(() => {
      this.#dragFrame = 0
      if (this.#dragShare) this.#share({ ...this.#presence, dragging: this.#dragShare })
    })
  }

  /** A drag writes where it left the nodes once it ends, so others see one move. */
  onNodeDragStop(nodes: readonly NodeBase[]): void {
    cancelAnimationFrame(this.#dragFrame)
    this.#dragFrame = 0
    this.#dragShare = null
    moveNodes(
      this.#doc,
      nodes.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })),
      BOARD_ORIGIN,
    )
    for (const n of nodes) this.#dragging.delete(n.id)
    // After the move: the ghost goes once the node is where it was dropped,
    // so others never see it snap back in between.
    this.#share({ ...this.#presence, dragging: undefined })
  }

  onNodesDelete(nodes: readonly NodeBase[]): void {
    deleteNodes(
      this.#doc,
      nodes.map((n) => n.id),
      BOARD_ORIGIN,
    )
  }

  onEdgesDelete(edges: readonly EdgeBase[]): void {
    deleteEdges(
      this.#doc,
      edges.map((e) => e.id),
      BOARD_ORIGIN,
    )
  }

  /** A connection drawn from one node's side to another's: a new edge. */
  onConnect(c: Connection): void {
    if (c.source === c.target) return
    addEdge(
      this.#doc,
      {
        id: newId(),
        fromNode: c.source,
        fromSide: asSide(c.sourceHandle),
        toNode: c.target,
        toSide: asSide(c.targetHandle),
      },
      BOARD_ORIGIN,
    )
  }

  /** A double click: on a text node, type in it; on the empty board, add one there. */
  onDoubleClick(e: MouseEvent): void {
    const target = e.target as Element
    // A quick second click on the JSON toggle is not a place to add a node.
    if (target.closest('.canvas-editor, .canvas-json-toggle')) return
    const id = target.closest<HTMLElement>('.bf-flow__node')?.dataset.id
    if (id) this.edit(id)
    else this.addTextAt(e.clientX, e.clientY)
  }

  /** A new text node at a point on the screen, to type in. */
  addTextAt(clientX: number, clientY: number): void {
    if (this.#readOnly) return
    const store = this.#store
    const pane = store?.domNode()
    if (!store || !pane) return
    const rect = pane.getBoundingClientRect()
    const [tx, ty, zoom] = store.getTransform()
    const id = newId()
    addNode(
      this.#doc,
      {
        id,
        type: 'text',
        text: '',
        x: (clientX - rect.left - tx) / zoom - NEW_NODE.width / 2,
        y: (clientY - rect.top - ty) / zoom - NEW_NODE.height / 2,
        ...NEW_NODE,
      },
      BOARD_ORIGIN,
    )
    this.#publish()
    // Once xyflow has drawn the new node.
    requestAnimationFrame(() => this.edit(id))
  }

  /**
   * Makes a node's element selectable, with resize handles shown while it is
   * selected. The body calls it once mounted, inside xyflow's node element.
   */
  attachNode(body: HTMLElement, id: string): void {
    queueMicrotask(() => {
      const store = this.#store
      const wrapper = body.closest<HTMLElement>('.bf-flow__node')
      if (!store || !wrapper || this.#resizers.has(id)) return
      // Click to select: the JSX NodeWrapper of @barefootjs/xyflow 0.39 does
      // not wire this up, though its docs say the node wrapper does.
      setupNodeSelection(wrapper, id, store)
      this.#resizers.set(
        id,
        initNodeResizer(wrapper, id, store, {
          minWidth: MIN_SIZE.width,
          minHeight: MIN_SIZE.height,
          shouldResize: () => !this.#readOnly,
          onResize: (_, p) => this.#resizing(id, p),
          onResizeEnd: (_, p) => {
            resizeNode(this.#doc, id, p, BOARD_ORIGIN)
            this.#dragging.delete(id)
          },
        }),
      )
    })
  }

  /** While resizing, the body follows the handles; the document gets the end. */
  #resizing(id: string, p: { x: number; y: number; width: number; height: number }): void {
    this.#dragging.add(id)
    const store = this.nodes.get(id)
    if (!store) return
    const n = untrack(() => store.get())
    store.set({ ...n, width: p.width, height: p.height })
  }

  /** Starts typing in a text node. */
  edit(id: string): void {
    if (this.#readOnly) return
    const node = this.nodes.get(id)
    if (!node || untrack(() => node.get()).type !== 'text') return
    if (untrack(() => this.editing.get()) === id) return
    this.finishEditing()
    const host = this.#store
      ?.domNode()
      ?.querySelector<HTMLElement>(`.bf-flow__node[data-id="${CSS.escape(id)}"] .canvas-editor`)
    if (!host) return
    this.editing.set(id)
    this.#share({ ...this.#presence, editing: id })
    this.#mountEditor(host, id)
  }

  /**
   * Puts an editor for the node's text in `host`: CodeMirror on the text's
   * Y.Text, so typing merges by character and others' cursors show.
   */
  #mountEditor(host: HTMLElement, id: string): void {
    const text = textOf(this.#doc, id)
    if (!text) return
    this.#editor?.destroy()
    this.#editor = new EditorView({
      parent: host,
      // yCollab keeps the two in step from here; it does not fill the editor.
      doc: text.toString(),
      extensions: [
        keymap.of([
          { key: 'Escape', run: () => (this.finishEditing(), true) },
          ...yUndoManagerKeymap,
          ...defaultKeymap,
        ]),
        markdown(),
        EditorView.lineWrapping,
        nodeEditorTheme,
        yCollab(text, this.#awareness, { undoManager: this.#undo }),
        EditorView.domEventHandlers({ blur: () => this.finishEditing() }),
      ],
    })
    // Ready to go on typing where the text ends.
    this.#editor.dispatch({ selection: { anchor: this.#editor.state.doc.length } })
    this.#editor.focus()
  }

  finishEditing(): void {
    if (this.#editor) {
      this.#editor.destroy()
      // yCollab clears the cursor only while its view has focus, and a
      // destroyed view never updates again: others would keep seeing it.
      this.#awareness.setLocalStateField('cursor', null)
    }
    this.#editor = null
    this.editing.set(null)
    this.#share({ ...this.#presence, editing: undefined })
  }

  /** Undo and redo for the board, as the text editor has. */
  onKey(e: KeyboardEvent): void {
    if (this.#readOnly || untrack(() => this.editing.get())) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    if (mod && key === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.#undo.redo()
      else this.#undo.undo()
    } else if (mod && key === 'y') {
      e.preventDefault()
      this.#undo.redo()
    }
  }
}
