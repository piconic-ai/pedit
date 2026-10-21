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
  const known = Y.decodeStateVector(Y.encodeStateVector(doc))
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
  const n = size([...have.recs, ...lists.recs.slice(lists.doc)], merged(have.deleted, u.deleted))
  if (n > META_LIMITS.maxDocBytes) return { reason: `the comments could take ${n} bytes` }
  return null
}

/**
 * The measure checkMetaUpdate limits, of `doc`, a metadata doc, as
 * internal/meta's DocSize.
 */
export function metaDocSize(doc: Y.Doc): number {
  const s = scan(Y.encodeStateAsUpdate(doc))
  return size(s.recs, merged(s.deleted))
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
  /** An item whose content is gone. */
  deleted: boolean
  /** What a live item takes, by the measure size uses. */
  bytes: number
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

type Place = Pick<
  Rec,
  'item' | 'values' | 'deleted' | 'bytes' | 'origin' | 'parent' | 'root' | 'key'
>

/** Where a struct goes, refusing content, or a place, no comments have. */
function placeOf(s: Y.Item | Y.GC): Place {
  const none = { origin: null, parent: null, root: null, key: null }
  if (!(s instanceof Y.Item))
    return { item: false, values: false, deleted: false, bytes: 0, ...none }
  const c = s.content
  const fits =
    c instanceof Y.ContentAny ||
    c instanceof Y.ContentDeleted ||
    (c instanceof Y.ContentType && c.type instanceof Y.Map)
  const parent = s.parent as unknown
  const placed = s.origin !== null || s.parentSub !== null
  const root = s.origin === null && typeof parent === 'string' ? parent : null
  if (!fits || !placed || s.rightOrigin !== null || (root !== null && root !== 'comments')) {
    throw new ScanError('not content a comments doc holds')
  }
  if (s.origin === null && utf8Len(s.parentSub ?? '') > MAX_KEY) {
    throw new ScanError('not content a comments doc holds: a long key')
  }
  const place: Place = {
    item: true,
    values: c instanceof Y.ContentAny,
    deleted: c instanceof Y.ContentDeleted,
    bytes: 0,
    origin: s.origin,
    parent: s.origin === null && parent instanceof Y.ID ? parent : null,
    root,
    key: s.parentSub,
  }
  let content = 1 // a map
  if (c instanceof Y.ContentAny)
    content = c.arr.reduce((n, v) => n + anyLen(v), varLen(c.arr.length))
  else if (c instanceof Y.ContentDeleted) content = varLen(c.len)
  place.bytes = header(place) + content
  return place
}

/** A key in the comments: ids of threads and comments are at most 32 characters. */
const MAX_KEY = 64

/** What an item's place takes, as Yjs writes it. */
function header(r: Pick<Rec, 'origin' | 'parent' | 'root' | 'key'>): number {
  if (r.origin) return 1 + varLen(r.origin.client) + varLen(r.origin.clock)
  const n = 2 + strLen(r.key ?? '')
  if (r.parent) return n + varLen(r.parent.client) + varLen(r.parent.clock)
  return n + strLen(r.root ?? '')
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
}

/**
 * Yjs and ygo encode one doc in different sizes: Yjs merges the runs of
 * structs a doc deletes, and ygo keeps each. So the limit on a doc is on a
 * measure every peer works out alike from its structs, and that neither
 * encoding passes, as internal/meta/size.go: a live item takes what Yjs
 * writes for it, each clock of deleted content DEAD_BYTES, and each client
 * CLIENT_BYTES plus its id twice.
 */
const DEAD_BYTES = 96
const CLIENT_BYTES = 12

/** The measure of a doc of `recs`, with `deleted`, sorted and joined. */
function size(recs: Rec[], deleted: Map<number, Array<[number, number]>>): number {
  let n = 2
  const clients = new Set<number>(deleted.keys())
  for (const r of recs) {
    clients.add(r.client)
    let gone = r.length
    if (r.item && !r.deleted) {
      gone = overlap(deleted.get(r.client) ?? [], r.clock, r.length)
      if (gone < r.length) n += r.bytes
    }
    n += DEAD_BYTES * gone
  }
  for (const c of clients) n += CLIENT_BYTES + 2 * varLen(c)
  return n
}

/** Each client's deleted ranges, of all of `sets`, sorted and joined. */
function merged(
  ...sets: Array<Map<number, Array<[number, number]>>>
): Map<number, Array<[number, number]>> {
  const out = new Map<number, Array<[number, number]>>()
  for (const set of sets) {
    for (const [c, ranges] of set) out.set(c, [...(out.get(c) ?? []), ...ranges])
  }
  for (const [c, ranges] of out) {
    ranges.sort((a, b) => a[0] - b[0])
    const joined: Array<[number, number]> = []
    for (const [clock, len] of ranges) {
      const last = joined[joined.length - 1]
      if (last && clock <= last[0] + last[1]) last[1] = Math.max(last[1], clock + len - last[0])
      else joined.push([clock, len])
    }
    out.set(c, joined)
  }
  return out
}

/** How much of [clock, clock+len) `ranges`, sorted and joined, cover. */
function overlap(ranges: Array<[number, number]>, clock: number, len: number): number {
  const end = clock + len
  let lo = 0
  let hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]!
    if (r[0] + r[1] > clock) hi = mid
    else lo = mid + 1
  }
  let n = 0
  for (let i = lo; i < ranges.length && ranges[i]![0] < end; i++) {
    const [c, l] = ranges[i]!
    n += Math.min(end, c + l) - Math.max(clock, c)
  }
  return n
}

/** How many bytes lib0 writes for a value, as decoded. */
function anyLen(v: unknown): number {
  if (v === null || v === undefined || typeof v === 'boolean') return 1
  if (typeof v === 'number') return numberLen(v)
  if (typeof v === 'bigint') return 9
  if (typeof v === 'string') return 1 + strLen(v)
  if (v instanceof Uint8Array) return 1 + varLen(v.length) + v.length
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + anyLen(x), 1 + varLen(v.length))
  const entries = Object.entries(v as object)
  return entries.reduce((n, [k, x]) => n + strLen(k) + anyLen(x), 1 + varLen(entries.length))
}

/**
 * How many bytes lib0 writes for a number: a varint for an integer of 31
 * bits, else a float32 when it holds it, else a float64.
 */
function numberLen(x: number): number {
  if (Number.isInteger(x) && Math.abs(x) <= 0x7fffffff) {
    let n = 1
    for (let a = Math.floor(Math.abs(x) / 64); a > 0; a = Math.floor(a / 128)) n++
    return n
  }
  return Math.fround(x) === x ? 5 : 9
}

const utf8 = new TextEncoder()

function utf8Len(s: string): number {
  return utf8.encode(s).length
}

/** How many bytes a string takes, with its length. */
function strLen(s: string): number {
  const n = utf8Len(s)
  return varLen(n) + n
}

/** How many bytes x takes as a varuint. */
function varLen(x: number): number {
  let n = 1
  for (; x >= 0x80; x = Math.floor(x / 0x80)) n++
  return n
}
