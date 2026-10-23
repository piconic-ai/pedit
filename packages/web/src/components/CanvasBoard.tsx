'use client'

import { useContext } from '@barefootjs/client'
import { type EdgeBase, type NodeBase, Position } from '@barefootjs/xyflow'
import { BoardContext, type BoardView, MAX_ZOOM, MIN_ZOOM } from '../board.ts'
import { nodeText } from '../canvas.ts'
import type { JsonStatus } from '../jsonpane.ts'
import { Flow, Handle } from './xyflow/index.tsx'

/** What the JSON pane says under the text. */
const statusText = (status: JsonStatus | undefined) => {
  switch (status?.kind) {
    case 'editing':
      return 'Editing…'
    case 'invalid':
      return `Not valid JSON yet: ${status.message}`
    case 'too-large':
      return 'Too large to send in one go.'
    case 'sending':
      return 'Sending to the host…'
    case 'rejected':
      return status.message
    case 'closed':
      return 'The room has closed.'
    default:
      return 'In step with the canvas.'
  }
}

/** Only web links open from a link node; anything else is shown, not followed. */
const webUrl = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined)

/**
 * A field as the text a card shows. read() lets only strings through, but a
 * slot renders an object it is given as markup, so nothing else gets near one.
 */
const shownText = (v: unknown) => (typeof v === 'string' ? v : '')

/** A node's colour: a preset "1" to "6" goes to CSS, a hex colour is set as it is. */
const presetOf = (color: string | undefined) => (color && /^[1-6]$/.test(color) ? color : undefined)
const hexOf = (color: string | undefined) =>
  color && /^#[0-9a-f]{3,8}$/i.test(color) ? `--card-color: ${color};` : ''

/**
 * One node of the board: its body by type, a handle on every side to draw an
 * edge from or to, and an editor in place of the text while someone types.
 * xyflow hands it the node; the view comes from BoardContext.
 */
export function CanvasCard(props: NodeBase) {
  const v = useContext(BoardContext) as BoardView
  const nodeId = props.id
  const node = () => v.nodes.get(nodeId)?.get()
  const editing = () => v.editing.get() === nodeId
  // What the body shows: a link's body is hidden for the link below it.
  const bodyText = () => {
    const n = node()
    return n ? nodeText(n) : ''
  }
  // Others on this node; their colour is a hex colour, from participants().
  const peer = () => v.peers.get()[nodeId]
  const style = () => {
    const n = node()
    const p = peer()
    const peerColor = p ? ` --peer-color: ${p.color};` : ''
    return n ? `width: ${n.width}px; height: ${n.height}px; ${hexOf(n.color)}${peerColor}` : ''
  }

  return (
    <div
      className={`canvas-card canvas-card--${node()?.type ?? 'text'}`}
      data-color={presetOf(node()?.color)}
      data-editing={editing() ? '' : undefined}
      data-peer={peer() ? '' : undefined}
      data-comment={v.commented.get().has(nodeId) ? '' : undefined}
      style={style()}
      ref={(el) => v.attachNode(el, nodeId)}
    >
      {/* Who else is on it; empty, and hidden by CSS, when nobody is. */}
      <span className="canvas-peer">{peer()?.names ?? ''}</span>
      {/* A target under a source on each side: edges start from the source,
          and the connection snaps to the other node's target. */}
      <Handle type="target" position={Position.Top} id="top" nodeId={nodeId} />
      <Handle type="source" position={Position.Top} id="top" nodeId={nodeId} />
      <Handle type="target" position={Position.Right} id="right" nodeId={nodeId} />
      <Handle type="source" position={Position.Right} id="right" nodeId={nodeId} />
      <Handle type="target" position={Position.Bottom} id="bottom" nodeId={nodeId} />
      <Handle type="source" position={Position.Bottom} id="bottom" nodeId={nodeId} />
      <Handle type="target" position={Position.Left} id="left" nodeId={nodeId} />
      <Handle type="source" position={Position.Left} id="left" nodeId={nodeId} />
      {/* Always there, so the editor the view puts in it stays put; shown
          while someone types, in place of the text. */}
      <div className="canvas-editor nodrag nowheel" />
      {/* One body for every type, and a link that CSS shows for link nodes
          only: without conditionals, as text inside a conditional branch,
          and a `hidden` binding, do not update when rendered in the browser. */}
      <div className="canvas-body">{bodyText()}</div>
      <a
        className="canvas-link nodrag"
        href={webUrl(node()?.url)}
        target="_blank"
        rel="noopener noreferrer"
      >
        {shownText(node()?.url)}
      </a>
    </div>
  )
}

/**
 * Draws a BoardView (board.ts) with @barefootjs/xyflow: pan and zoom, the
 * nodes as cards, the edges with their arrows and labels. Every change goes
 * back to the view, which writes it to the shared document.
 */
export function CanvasBoard(props: { view: BoardView }) {
  const v = props.view
  return (
    <BoardContext.Provider value={v}>
      <section
        className="canvas-view"
        aria-label="Canvas"
        data-json={v.showJson.get() ? '' : undefined}
      >
        <div className="canvas-json" ref={(el) => v.mountJson(el)}>
          <p className="canvas-json-status" data-kind={v.json?.status.get().kind}>
            {statusText(v.json?.status.get())}
          </p>
        </div>
        <div
          className="canvas-board"
          onKeyDown={(e) => v.onKey(e)}
          // One handler for the board: xyflow captures the pointer on a node's
          // element, so a double click lands there rather than on the card.
          onDoubleClick={(e) => v.onDoubleClick(e)}
        >
          <svg className="canvas-markers" aria-hidden="true" width="0" height="0">
            <defs>
              <marker
                id="canvas-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M0,0 L10,5 L0,10 z" />
              </marker>
            </defs>
          </svg>
          <Flow
            // The view fills them in from the document once the flow exists.
            nodes={[] as NodeBase[]}
            edges={[] as EdgeBase[]}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            zoomOnDoubleClick={false}
            onInit={(store) => v.onInit(store)}
            onNodeDragStart={(_e, _node, nodes) => v.onNodeDragStart(nodes)}
            onNodeDrag={(_e, _node, nodes) => v.onNodeDrag(nodes)}
            onNodeDragStop={(_e, _node, nodes) => v.onNodeDragStop(nodes)}
            onNodesDelete={(nodes) => v.onNodesDelete(nodes)}
            onEdgesDelete={(edges) => v.onEdgesDelete(edges)}
            onConnect={(c) => v.onConnect(c)}
            renderNode={CanvasCard}
          />
          <p className="canvas-hint" hidden={!v.empty.get()}>
            Double-click to add a card.
          </p>
          {/* The JSON is a back door: a small button, not a view in the header. */}
          <button
            type="button"
            className="canvas-json-toggle"
            aria-pressed={v.showJson.get() ? 'true' : 'false'}
            title={v.showJson.get() ? 'Hide JSON' : 'Show JSON'}
            onClick={() => v.toggleJson()}
          >
            {'{ }'}
          </button>
        </div>
      </section>
    </BoardContext.Provider>
  )
}
