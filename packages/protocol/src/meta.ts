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
  /**
   * Bounds the time applying the doc's lists can take, as the sum of the
   * squares of their lengths, as internal/meta/check.go's MaxListWork: a list
   * holds the items set under one key of a map, and Yjs takes time up to the
   * square of its length to apply items to it.
   */
  maxListWork: 1 << 20,
} as const

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
 * - applying the doc's lists, with it, could take more than maxListWork;
 * - the doc could pass maxDocBytes.
 */
export function checkMetaUpdate(doc: Y.Doc, update: Uint8Array): Refusal | null {
  const sv = Y.encodeStateVector(doc)
  const known = Y.decodeStateVector(sv)
  let u: Scanned
  try {
    u = scan(update)
  } catch (e) {
    return { reason: e instanceof ScanError ? e.message : 'not a valid update' }
  }
  const end = new Map<number, number>()
  for (const r of u.recs) {
    if (!end.has(r.client) && r.clock > (known.get(r.client) ?? 0)) {
      return { reason: `it skips structs of client ${r.client}`, retryLater: true }
    }
    end.set(r.client, r.clock + r.length)
    if (r.clock + r.length > META_LIMITS.maxClientClock) {
      return { reason: `client ${r.client} passed ${META_LIMITS.maxClientClock} operations` }
    }
  }
  for (const [client, ranges] of u.deleted) {
    for (const [clock, len] of ranges) {
      if (clock + len > Math.max(known.get(client) ?? 0, end.get(client) ?? 0)) {
        return { reason: 'it deletes what was not received', retryLater: true }
      }
    }
  }
  const state = Y.encodeStateAsUpdate(doc)
  const have = scan(state)
  const lists = new Lists(have.recs, freshOf(u.recs, known))
  const { missing, long } = lists.check()
  if (missing) return { reason: 'it needs updates not received yet', retryLater: true }
  if (long) return { reason: 'its lists would take too long to apply' }
  const size = sizeAfter(state.length, have, u, lists, Y.diffUpdate(update, sv))
  if (size > META_LIMITS.maxDocBytes) return { reason: `the comments could take ${size} bytes` }
  return null
}

/**
 * A struct: an item, or a run of collected garbage. An item goes after its
 * origin, in the same list, or, without one, at the start of the list of
 * `key` in its parent: an item, or a root type. See internal/meta/scan.go.
 */
interface Rec {
  client: number
  clock: number
  length: number
  item: boolean
  /** An item of plain values, which a map's are one of. */
  values: boolean
  origin: Y.ID | null
  parent: Y.ID | null
  root: string | null
  key: string | null
}

/** An update's structs and deleted ranges, [clock, length] by client. */
interface Scanned {
  recs: Rec[]
  deleted: Map<number, Array<[number, number]>>
}

class ScanError extends Error {}

/**
 * Reads the structs of `update` without applying it, refusing what no
 * comments hold, and a client whose structs are not one run: Yjs keeps only
 * its last run, and the rest would wait for the gap.
 */
function scan(update: Uint8Array): Scanned {
  const { structs, ds } = Y.decodeUpdate(update)
  const u: Scanned = { recs: [], deleted: new Map() }
  const done = new Set<number>()
  let last = null as Rec | null
  for (const s of structs) {
    if (s instanceof Y.Skip) throw new ScanError('it skips structs')
    const { client, clock } = s.id
    if (last !== null && last.client === client) {
      if (clock !== last.clock + last.length) throw new ScanError('structs of one client twice')
    } else {
      if (done.has(client)) throw new ScanError('structs of one client twice')
      if (last) done.add(last.client)
    }
    last = { client, clock, length: s.length, ...placeOf(s as Y.Item | Y.GC) }
    u.recs.push(last)
  }
  for (const [client, ranges] of ds.clients) {
    u.deleted.set(
      client,
      ranges.map((r) => [r.clock, r.len]),
    )
  }
  return u
}

/** Where a struct goes, refusing content, or a place, no comments have. */
function placeOf(
  s: Y.Item | Y.GC,
): Pick<Rec, 'item' | 'values' | 'origin' | 'parent' | 'root' | 'key'> {
  const none = { origin: null, parent: null, root: null, key: null }
  if (!(s instanceof Y.Item)) return { item: false, values: false, ...none }
  const c = s.content
  const fits =
    c instanceof Y.ContentAny ||
    c instanceof Y.ContentDeleted ||
    (c instanceof Y.ContentType && c.type instanceof Y.Map)
  const parent = s.parent as unknown
  const placed = s.origin !== null || s.parentSub !== null
  if (!fits || !placed || s.rightOrigin !== null) {
    throw new ScanError('not content a comments doc holds')
  }
  return {
    item: true,
    values: c instanceof Y.ContentAny,
    origin: s.origin,
    parent: s.origin === null && parent instanceof Y.ID ? parent : null,
    root: s.origin === null && typeof parent === 'string' ? parent : null,
    key: s.parentSub,
  }
}

/**
 * The records of an update the doc, at `known`, does not have: a struct it
 * has the start of is cut to the rest, which follows the last clock the doc
 * has, as Yjs applies it.
 */
function freshOf(recs: Rec[], known: Map<number, number>): Rec[] {
  const fresh: Rec[] = []
  for (const r of recs) {
    const k = known.get(r.client) ?? 0
    if (r.clock + r.length <= k) continue
    if (r.clock < k) {
      const cut = { ...r, clock: k, length: r.length - (k - r.clock) }
      if (r.item)
        Object.assign(cut, { origin: Y.createID(r.client, k - 1), parent: null, root: null })
      fresh.push(cut)
    } else fresh.push(r)
  }
  return fresh
}

/**
 * The list of each record of the doc and of an update's new ones, by parent
 * and key or by the item each follows, as Yjs would, found without
 * recursion. See internal/meta/lists.go.
 */
class Lists {
  readonly recs: Rec[]
  readonly doc: number
  readonly byClient = new Map<number, number[]>()
  /** Each record's list ('' for none), or null when it cannot be placed. */
  readonly list: Array<string | null | undefined>

  constructor(doc: Rec[], fresh: Rec[]) {
    this.recs = [...doc, ...fresh]
    this.doc = doc.length
    this.recs.forEach((r, i) => {
      const is = this.byClient.get(r.client) ?? []
      is.push(i)
      this.byClient.set(r.client, is)
    })
    for (const is of this.byClient.values()) {
      is.sort((a, b) => this.recs[a]!.clock - this.recs[b]!.clock)
    }
    this.list = new Array(this.recs.length)
  }

  /** The record holding a clock of a client, or -1. */
  find(client: number, clock: number): number {
    const is = this.byClient.get(client) ?? []
    let lo = 0
    let hi = is.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const r = this.recs[is[mid]!]!
      if (r.clock + r.length > clock) hi = mid
      else lo = mid + 1
    }
    const i = is[lo]
    return i !== undefined && this.recs[i]!.clock <= clock ? i : -1
  }

  /**
   * Where record i's list comes from: the record it depends on (-1: none),
   * which must be placed for it to be, and its own list ('': take that
   * record's). With no record, null: it cannot be placed.
   */
  step(i: number): { dep: number; list: string | null } {
    const r = this.recs[i]!
    if (!r.item) return { dep: -1, list: '' }
    const dep = r.origin ?? r.parent
    if (dep === null) return { dep: -1, list: `r ${r.root}\0${r.key}` }
    if (dep.client === r.client && dep.clock >= r.clock) return { dep: -1, list: null }
    const j = this.find(dep.client, dep.clock)
    if (j < 0) return { dep: -1, list: null }
    return { dep: j, list: r.origin === null ? `p ${dep.client} ${dep.clock}\0${r.key}` : '' }
  }

  /**
   * Whether an update's records can all be placed, and whether applying the
   * doc's lists, with them, could take more than maxListWork. A run of
   * values weighs as many items: it splits, copying the rest of it, each time
   * an item goes inside it.
   */
  check(): { missing: boolean; long: boolean } {
    const { list } = this
    const seen = new Set<number>()
    for (let i = 0; i < this.recs.length; i++) {
      const stack = [i]
      while (stack.length > 0) {
        const k = stack[stack.length - 1]!
        if (list[k] !== undefined) {
          stack.pop()
          continue
        }
        const { dep, list: own } = this.step(k)
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
    this.recs.forEach((r, i) => {
      const l = list[i]
      if (l) lengths.set(l, (lengths.get(l) ?? 0) + (r.values ? r.length : 1))
    })
    let work = 0
    for (const n of lengths.values()) work += n * n
    return { missing: list.slice(this.doc).includes(null), long: work > META_LIMITS.maxListWork }
  }

  /** How many ends of a deleted range fall inside a struct, splitting it. */
  splits(client: number, clock: number, len: number): number {
    let n = 0
    for (const x of [clock, clock + len]) {
      const i = this.find(client, x)
      if (i >= 0 && this.recs[i]!.clock !== x) n++
    }
    return n
  }
}

/**
 * About how many bytes the doc would take with the update: its new structs,
 * as `diff` encodes them alone, the deleted ranges the doc does not have,
 * and a struct header for each split those make. See internal/meta/check.go.
 */
function sizeAfter(
  state: number,
  have: Scanned,
  u: Scanned,
  lists: Lists,
  diff: Uint8Array,
): number {
  let n = state + diff.length - deletedBytes(scan(diff)) + 16
  for (const [client, ranges] of u.deleted) {
    const theirs = have.deleted.get(client) ?? []
    let newClient = theirs.length === 0
    for (const [clock, len] of ranges) {
      if (theirs.some(([c, l]) => c <= clock && clock + len <= c + l)) continue
      if (newClient) {
        n += varLen(client) + 1
        newClient = false
      }
      n += varLen(clock) + varLen(len) + 24 * lists.splits(client, clock, len)
    }
  }
  return n
}

/** How many bytes a delete set takes, encoded. */
function deletedBytes(s: Scanned): number {
  let n = varLen(s.deleted.size)
  for (const [client, ranges] of s.deleted) {
    n += varLen(client) + varLen(ranges.length)
    for (const [clock, len] of ranges) n += varLen(clock) + varLen(len)
  }
  return n
}

/** How many bytes x takes as a varuint. */
function varLen(x: number): number {
  let n = 1
  for (; x >= 0x80; x = Math.floor(x / 0x80)) n++
  return n
}
