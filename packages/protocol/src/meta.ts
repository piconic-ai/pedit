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
 * Bounds the time applying the doc's lists can take, as the sum of the
 * squares of their lengths, as internal/meta/check.go's MaxListWork: a list
 * holds the items set under one key of a map, and Yjs takes time up to the
 * square of its length to apply items to it.
 */
export const MAX_LIST_WORK = 1 << 21

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
 * - applying the doc's lists, with it, could take more than MAX_LIST_WORK;
 * - the doc could pass maxDocBytes.
 */
export function checkMetaUpdate(doc: Y.Doc, update: Uint8Array): Refusal | null {
  const known = Y.decodeStateVector(Y.encodeStateVector(doc))
  let u: Scanned
  try {
    u = scan(update)
  } catch (e) {
    return { reason: e instanceof ScanError ? e.message : 'not a valid update' }
  }
  const end = new Map<number, number>()
  for (const r of u.recs) {
    const { client, clock } = r.id
    if (!end.has(client) && clock > (known.get(client) ?? 0)) {
      return { reason: `it skips structs of client ${client}`, retryLater: true }
    }
    end.set(client, clock + r.length)
    if (clock + r.length > META_LIMITS.maxClientClock) {
      return { reason: `client ${client} passed ${META_LIMITS.maxClientClock} operations` }
    }
  }
  for (const [client, e] of u.deleted) {
    if (e > Math.max(known.get(client) ?? 0, end.get(client) ?? 0)) {
      return { reason: 'it deletes what was not received', retryLater: true }
    }
  }
  const state = Y.encodeStateAsUpdate(doc)
  const size = state.length + update.length + 32 * u.ranges
  if (size > META_LIMITS.maxDocBytes) return { reason: `the comments could take ${size} bytes` }
  const fresh = u.recs.filter((r) => r.id.clock + r.length > (known.get(r.id.client) ?? 0))
  const { missing, long } = checkLists(scan(state).recs, fresh)
  if (missing) return { reason: 'it needs updates not received yet', retryLater: true }
  if (long) return { reason: 'its lists would take too long to apply' }
  return null
}

/** A struct of an update: an item, or a run of collected garbage. */
type Rec = Y.Item | Y.GC

/** An update's structs and deletions; see internal/meta/scan.go. */
interface Scanned {
  recs: Rec[]
  deleted: Map<number, number>
  ranges: number
}

class ScanError extends Error {}

/**
 * Reads the structs of `update` without applying it, refusing what no
 * comments hold, and a client whose structs are not one run: Yjs keeps only
 * its last run, and the rest would wait for the gap.
 */
function scan(update: Uint8Array): Scanned {
  const { structs, ds } = Y.decodeUpdate(update)
  const u: Scanned = { recs: [], deleted: new Map(), ranges: 0 }
  const done = new Set<number>()
  let last: Rec | null = null
  for (const s of structs) {
    if (s instanceof Y.Skip) throw new ScanError('it skips structs')
    const { client, clock } = s.id
    if (last?.id.client === client) {
      if (clock !== last.id.clock + last.length) throw new ScanError('structs of one client twice')
    } else {
      if (done.has(client)) throw new ScanError('structs of one client twice')
      if (last) done.add(last.id.client)
    }
    if (s instanceof Y.Item) holdsComments(s)
    u.recs.push(s as Rec)
    last = s as Rec
  }
  for (const [client, ranges] of ds.clients) {
    for (const r of ranges) {
      u.deleted.set(client, Math.max(u.deleted.get(client) ?? 0, r.clock + r.len))
      u.ranges++
    }
  }
  return u
}

/** Refuses an item with content, or a place, no comments have. */
function holdsComments(item: Y.Item): void {
  const c = item.content
  const fits =
    c instanceof Y.ContentAny ||
    c instanceof Y.ContentDeleted ||
    (c instanceof Y.ContentType && c.type instanceof Y.Map)
  const placed = item.origin !== null || item.parentSub !== null
  if (!fits || !placed || item.rightOrigin !== null) {
    throw new ScanError('not content a comments doc holds')
  }
}

/**
 * Finds the list of each record of the doc and of an update's new ones, by
 * parent and key or by the item each follows, as Yjs would, without
 * recursion, and tells whether a new one cannot be placed (it would wait),
 * or makes the lists too long to apply. See internal/meta/lists.go.
 */
function checkLists(doc: Rec[], fresh: Rec[]): { missing: boolean; long: boolean } {
  const recs = [...doc, ...fresh]
  const byClient = new Map<number, number[]>()
  recs.forEach((r, i) => {
    const is = byClient.get(r.id.client) ?? []
    is.push(i)
    byClient.set(r.id.client, is)
  })
  for (const is of byClient.values()) is.sort((a, b) => recs[a]!.id.clock - recs[b]!.id.clock)
  const find = (x: Y.ID): number => {
    const is = byClient.get(x.client) ?? []
    let lo = 0
    let hi = is.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const r = recs[is[mid]!]!
      if (r.id.clock + r.length > x.clock) hi = mid
      else lo = mid + 1
    }
    const i = is[lo]
    return i !== undefined && recs[i]!.id.clock <= x.clock ? i : -1
  }
  // Where record i's list comes from: the record it depends on (-1: none),
  // which must be placed for it to be, and its own list ('': take that
  // record's). With no record, null: it cannot be placed.
  const step = (i: number): { dep: number; list: string | null } => {
    const r = recs[i]!
    if (!(r instanceof Y.Item)) return { dep: -1, list: '' }
    const parent = r.parent as unknown
    const dep = r.origin ?? (parent instanceof Y.ID ? parent : null)
    if (dep === null) return { dep: -1, list: `r ${String(parent)}\0${r.parentSub}` }
    if (dep.client === r.id.client && dep.clock >= r.id.clock) return { dep: -1, list: null }
    const j = find(dep)
    if (j < 0) return { dep: -1, list: null }
    return { dep: j, list: r.origin === null ? `p ${dep.client} ${dep.clock}\0${r.parentSub}` : '' }
  }
  // Each record's list ('' for garbage), or null when it cannot be placed.
  const list: Array<string | null | undefined> = new Array(recs.length)
  const seen = new Set<number>()
  for (let i = 0; i < recs.length; i++) {
    const stack = [i]
    while (stack.length > 0) {
      const k = stack[stack.length - 1]!
      if (list[k] !== undefined) {
        stack.pop()
        continue
      }
      const { dep, list: own } = step(k)
      if (dep < 0) list[k] = own
      else if (list[dep] !== undefined) list[k] = list[dep] === null ? null : own || list[dep]
      else if (seen.has(dep))
        list[k] = null // a cycle of origins or parents
      else {
        seen.add(k)
        stack.push(dep)
        continue
      }
      stack.pop()
    }
  }
  const lengths = new Map<string, number>()
  for (const l of list) if (l) lengths.set(l, (lengths.get(l) ?? 0) + 1)
  let work = 0
  for (const n of lengths.values()) work += n * n
  return { missing: list.slice(doc.length).includes(null), long: work > MAX_LIST_WORK }
}
