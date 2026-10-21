import * as Y from 'yjs'
import { MAX_FRAME_BYTES } from './frame.ts'
import type { Refusal } from './room.ts'

/**
 * Limits on a metadata doc, the comments of a file (#121), which every peer
 * applies to each update it receives, as internal/meta/check.go does: a
 * hostile key holder cannot make a peer hold more than it can send, since the
 * relay closes the socket of a peer whose frame passes 1 MiB.
 * Both check theirs against packages/testdata/meta-limits.json.
 */
export const META_LIMITS = {
  /**
   * So the doc's whole state fits the frame it is sent in, with room for the
   * frame's headers. The host shares no comments larger.
   */
  maxDocBytes: MAX_FRAME_BYTES - 4096,
  maxClientClock: 1 << 16,
} as const

/**
 * At most this many items may share a place in the doc (a parent, a key and
 * the item they were inserted after), as internal/meta/check.go's
 * MaxPlaceItems: Yjs takes time in the square of their number to apply them.
 */
export const MAX_PLACE_ITEMS = 64

/**
 * Tells why an update received for `doc`, a metadata doc, must not be
 * applied, or returns null. It reads the update without applying it, as
 * internal/meta/check.go does, and refuses it when:
 * - it holds anything but maps and plain values, as no comments do;
 * - part of it, structs or deletions, would wait for updates not received
 *   yet (Yjs keeps those as pending, and sends them on with the doc, past
 *   every check). This refusal is for now: the client asks the room again,
 *   and an honest peer's updates come back whole;
 * - it takes one of its clients past maxClientClock operations;
 * - it puts more than MAX_PLACE_ITEMS items in one place;
 * - the doc could pass maxDocBytes.
 */
export function checkMetaUpdate(doc: Y.Doc, update: Uint8Array): Refusal | null {
  const known = Y.decodeStateVector(Y.encodeStateVector(doc))
  let u: Scanned
  try {
    u = scan(update, known)
  } catch (e) {
    return { reason: e instanceof ScanError ? e.message : 'not a valid update' }
  }
  for (const [client, end] of u.end) {
    if (end > META_LIMITS.maxClientClock) {
      return { reason: `client ${client} passed ${META_LIMITS.maxClientClock} operations` }
    }
  }
  if (missing(u, known)) return { reason: 'it needs updates not received yet', retryLater: true }
  const state = Y.encodeStateAsUpdate(doc)
  const size = state.length + update.length + 32 * u.ranges
  if (size > META_LIMITS.maxDocBytes) return { reason: `the comments could take ${size} bytes` }
  const have = scan(state, null)
  for (const [p, n] of u.places) {
    if (n + (have.places.get(p) ?? 0) > MAX_PLACE_ITEMS) {
      return { reason: `more than ${MAX_PLACE_ITEMS} items in one place` }
    }
  }
  return null
}

/** What an update's structs and deletions name; see internal/meta/scan.go. */
interface Scanned {
  start: Map<number, number>
  end: Map<number, number>
  deps: Y.ID[]
  places: Map<string, number>
  deleted: Map<number, number>
  ranges: number
}

class ScanError extends Error {}

/**
 * Reads the structs of `update` without applying it. Places count only the
 * items `known`, the state of the doc, lacks; all of them when it is null.
 */
function scan(update: Uint8Array, known: Map<number, number> | null): Scanned {
  const { structs, ds } = Y.decodeUpdate(update)
  const u: Scanned = {
    start: new Map(),
    end: new Map(),
    deps: [],
    places: new Map(),
    deleted: new Map(),
    ranges: 0,
  }
  for (const s of structs) {
    if (s instanceof Y.Skip) throw new ScanError('it skips structs')
    const { client, clock } = s.id
    u.start.set(client, Math.min(u.start.get(client) ?? clock, clock))
    u.end.set(client, Math.max(u.end.get(client) ?? 0, clock + s.length))
    if (!(s instanceof Y.Item)) continue
    const place = placeOf(s, u)
    if (clock >= (known?.get(client) ?? 0)) u.places.set(place, (u.places.get(place) ?? 0) + 1)
  }
  for (const [client, ranges] of ds.clients) {
    for (const r of ranges) {
      u.deleted.set(client, Math.max(u.deleted.get(client) ?? 0, r.clock + r.len))
      u.ranges++
    }
  }
  return u
}

/** Where an item goes, as a key, after checking it holds what comments hold. */
function placeOf(item: Y.Item, u: Scanned): string {
  const c = item.content
  const fits =
    c instanceof Y.ContentAny ||
    c instanceof Y.ContentDeleted ||
    (c instanceof Y.ContentType && c.type instanceof Y.Map)
  if (!fits || item.rightOrigin !== null) {
    throw new ScanError('not content a comments doc holds')
  }
  if (item.origin !== null) {
    u.deps.push(item.origin)
    return `o ${item.origin.client} ${item.origin.clock}`
  }
  if (item.parentSub === null) throw new ScanError('not content a comments doc holds')
  const parent = item.parent as unknown
  if (typeof parent === 'string') return `r ${parent} ${item.parentSub}`
  if (parent instanceof Y.ID) {
    u.deps.push(parent)
    return `p ${parent.client} ${parent.clock} ${item.parentSub}`
  }
  throw new ScanError('not content a comments doc holds')
}

/** Whether a scanned update needs structs neither it nor the doc has. */
function missing(u: Scanned, known: Map<number, number>): boolean {
  const has = (client: number, clock: number) =>
    clock < Math.max(known.get(client) ?? 0, u.end.get(client) ?? 0)
  for (const [client, start] of u.start) {
    if (start > (known.get(client) ?? 0)) return true
  }
  if (u.deps.some((d) => !has(d.client, d.clock))) return true
  for (const [client, end] of u.deleted) {
    if (end > 0 && !has(client, end - 1)) return true
  }
  return false
}
