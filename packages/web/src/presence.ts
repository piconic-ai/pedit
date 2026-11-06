import { participants } from './core/room.ts'

/**
 * Where someone is on a canvas, as each browser shares it in its awareness
 * state under `canvas`: the nodes they have selected, the text node they are
 * typing in, and the node they are dragging, where the pointer has it now.
 * Positions travel in canvas coordinates, so they mean the same on every
 * screen, however it is panned and zoomed.
 */
export interface Presence {
  selected: string[]
  editing?: string
  dragging?: { id: string; x: number; y: number }
}

/** More than anyone selects by hand; anything past it is dropped. */
const MAX_SELECTED = 256
const MAX_ID = 64

const isId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= MAX_ID
const isCoordinate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Reads a peer's `canvas` field. It comes from other people's browsers, so
 * nothing is taken as it is: what is not the right shape is left out.
 */
export function presenceOf(value: unknown): Presence | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const selected = Array.isArray(v.selected) ? v.selected.filter(isId).slice(0, MAX_SELECTED) : []
  const presence: Presence = { selected }
  if (isId(v.editing)) presence.editing = v.editing
  const d = v.dragging as Record<string, unknown> | undefined
  if (d && typeof d === 'object' && isId(d.id) && isCoordinate(d.x) && isCoordinate(d.y)) {
    presence.dragging = { id: d.id, x: d.x, y: d.y }
  }
  return presence
}

/** Two presences that say the same, so an unchanged one is not sent again. */
export function samePresence(a: Presence, b: Presence): boolean {
  return (
    a.editing === b.editing &&
    a.selected.length === b.selected.length &&
    a.selected.every((id, i) => id === b.selected[i]) &&
    a.dragging?.id === b.dragging?.id &&
    a.dragging?.x === b.dragging?.x &&
    a.dragging?.y === b.dragging?.y
  )
}

/** Others on a node: their names, and the colour of the first. */
export interface NodePeers {
  names: string
  color: string
}

/** Someone dragging a node, and where they have it. */
export interface Ghost {
  id: string
  x: number
  y: number
  name: string
  color: string
}

export interface Peers {
  /** By node id: who has it selected or is typing in it. */
  nodes: Record<string, NodePeers>
  ghosts: Ghost[]
}

/** Where everyone else is on the canvas, by the awareness states. */
export function peersOf(states: Map<number, Record<string, unknown>>, selfId: number): Peers {
  const nodes: Record<string, NodePeers> = {}
  const ghosts: Ghost[] = []
  for (const p of participants(states, selfId)) {
    if (p.isSelf) continue
    const presence = presenceOf(states.get(p.clientId)?.canvas)
    if (!presence) continue
    const on = new Set(presence.selected)
    if (presence.editing) on.add(presence.editing)
    for (const id of on) {
      const seen = nodes[id]
      nodes[id] = seen
        ? { names: `${seen.names}, ${p.name}`, color: seen.color }
        : { names: p.name, color: p.color }
    }
    if (presence.dragging) ghosts.push({ ...presence.dragging, name: p.name, color: p.color })
  }
  return { nodes, ghosts }
}

/** Whether two sets of node peers are the same, so the cards are not repainted. */
export function sameNodePeers(a: Record<string, NodePeers>, b: Record<string, NodePeers>): boolean {
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => a[k]?.names === b[k]?.names && a[k]?.color === b[k]?.color)
  )
}
