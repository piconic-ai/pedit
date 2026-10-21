import * as encoding from 'lib0/encoding'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
// The Go side checks its own against the same file (internal/meta/check_test.go).
import limits from '../../testdata/meta-limits.json'
import { checkMetaUpdate, MAX_LIST_WORK, META_LIMITS } from '../src/index.ts'

function thread(doc: Y.Doc, id: string, quote: string) {
  doc.transact(() => {
    const t = new Y.Map()
    doc.getMap('comments').set(id, t)
    t.set('quote', quote)
  })
}

function updatesOf(doc: Y.Doc): Uint8Array[] {
  const out: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => out.push(u))
  return out
}

describe('checkMetaUpdate', () => {
  it('has the limits the Go side has', () => {
    expect({ ...META_LIMITS, maxListWork: MAX_LIST_WORK }).toEqual(limits)
  })

  it('takes an honest update', () => {
    const guest = new Y.Doc()
    const host = new Y.Doc()
    const updates = updatesOf(guest)
    thread(guest, 'c1', 'hello')
    for (const u of updates) {
      expect(checkMetaUpdate(host, u)).toBeNull()
      Y.applyUpdate(host, u)
    }
  })

  it('refuses an update with a gap, which Yjs would keep pending', () => {
    const guest = new Y.Doc()
    const updates = updatesOf(guest)
    thread(guest, 'c1', 'one')
    thread(guest, 'c2', 'two')
    expect(checkMetaUpdate(new Y.Doc(), updates[1] as Uint8Array)?.retryLater).toBe(true)
  })

  it('refuses deletions of what it has not, which Yjs would keep pending', () => {
    // A deletion of client 999's clocks 0-9, and no structs.
    const update = new Uint8Array([0, 1, 0xe7, 0x07, 1, 0, 10])
    expect(checkMetaUpdate(new Y.Doc(), update)?.retryLater).toBe(true)
  })

  it("looks only at the clocks of the update's clients", () => {
    const host = new Y.Doc()
    const m = host.getMap('comments')
    host.transact(() => {
      for (let i = 0; i <= META_LIMITS.maxClientClock; i++) m.set('k', i)
    })
    const guest = new Y.Doc()
    thread(guest, 'c1', 'hello')
    expect(checkMetaUpdate(host, Y.encodeStateAsUpdate(guest))).toBeNull()
  })

  it('refuses too many operations from one client', () => {
    const guest = new Y.Doc()
    const m = guest.getMap('comments')
    guest.transact(() => {
      for (let i = 0; i <= META_LIMITS.maxClientClock; i++) m.set('k', i)
    })
    expect(checkMetaUpdate(new Y.Doc(), Y.encodeStateAsUpdate(guest))).toMatchObject({
      reason: expect.stringMatching(/operations/),
    })
  })

  it('refuses a doc too large', () => {
    const guest = new Y.Doc()
    thread(guest, 'c1', 'x'.repeat(META_LIMITS.maxDocBytes))
    expect(checkMetaUpdate(new Y.Doc(), Y.encodeStateAsUpdate(guest))).toMatchObject({
      reason: expect.stringMatching(/bytes/),
    })
  })

  it('refuses what is not an update', () => {
    expect(checkMetaUpdate(new Y.Doc(), new Uint8Array([0xff, 0xff, 0xff]))).not.toBeNull()
  })

  it('refuses a long list', () => {
    // From review: Yjs takes time in the square of the items set at once in
    // one place.
    const sets = (n: number) => {
      const all = new Y.Doc()
      for (let i = 0; i < n; i++) {
        const peer = new Y.Doc()
        peer.getMap('comments').set('k', i)
        Y.applyUpdate(all, Y.encodeStateAsUpdate(peer))
      }
      return Y.encodeStateAsUpdate(all)
    }
    const most = Math.floor(Math.sqrt(MAX_LIST_WORK))
    expect(checkMetaUpdate(new Y.Doc(), sets(most))).toBeNull()
    expect(checkMetaUpdate(new Y.Doc(), sets(most + 1))?.reason).toMatch(/lists/)
    const host = new Y.Doc()
    Y.applyUpdate(host, sets(most))
    expect(checkMetaUpdate(host, sets(1))).not.toBeNull()
  })

  it('refuses what comments do not hold', () => {
    const edits: Array<(d: Y.Doc) => void> = [
      (d) => d.getText('t').insert(0, 'x'),
      (d) => d.getArray('a').push([1]),
      (d) => d.getMap('comments').set('t', new Y.Text('x')),
    ]
    for (const edit of edits) {
      const guest = new Y.Doc()
      edit(guest)
      expect(checkMetaUpdate(new Y.Doc(), Y.encodeStateAsUpdate(guest))?.reason).toMatch(
        /comments doc holds/,
      )
    }
  })

  it('counts the clocks an update reaches, not only from 0', () => {
    // From review: Yjs' encodeStateVectorFromUpdate counts no client whose
    // structs do not start at clock 0.
    const guest = new Y.Doc()
    const m = guest.getMap('comments')
    guest.transact(() => {
      for (let i = 0; i < META_LIMITS.maxClientClock; i++) m.set('k', i)
    })
    const host = new Y.Doc()
    Y.applyUpdate(host, Y.encodeStateAsUpdate(guest))
    const before = Y.encodeStateVector(guest)
    m.set('k', -1)
    const diff = Y.encodeStateAsUpdate(guest, before)
    expect(checkMetaUpdate(host, diff)?.reason).toMatch(/operations/)
  })

  it('refuses a list made long along a chain of origins', () => {
    // From review: no two items follow the same one, but the list is long.
    const n = 768 // a list of 1,536: more work than MAX_LIST_WORK
    const chain: Block = { client: 1, items: [] }
    for (let i = 0; i < n; i++) chain.items.push(i > 0 ? [1, i - 1] : null)
    const blocks = [chain]
    for (let i = 0; i < n; i++) blocks.push({ client: 1000 + i, items: [[1, i]] })
    expect(checkMetaUpdate(new Y.Doc(), encodeUpdate(blocks))?.reason).toMatch(/lists/)
  })

  it('refuses a run of values', () => {
    // From review: one item of many values counts as one in its list, and
    // ygo copies the rest of it for each item inserted inside it.
    const e = encoding.createEncoder()
    for (const n of [1, 1, 7, 0]) encoding.writeVarUint(e, n)
    encoding.writeUint8(e, 0x20 | 8)
    encoding.writeVarUint(e, 1)
    encoding.writeVarString(e, 'comments')
    encoding.writeVarString(e, 'k')
    encoding.writeVarUint(e, 2)
    encoding.writeAny(e, 1)
    encoding.writeAny(e, 2)
    encoding.writeVarUint(e, 0)
    expect(checkMetaUpdate(new Y.Doc(), encoding.toUint8Array(e))?.reason).toMatch(/run of values/)
  })

  it('refuses what Yjs would keep pending', () => {
    const cases: Block[][] = [
      [
        { client: 5, items: [null] },
        { client: 5, clock: 10, items: [null] },
      ],
      [
        { client: 5, items: [[6, 0]] },
        { client: 6, items: [[5, 0]] },
      ],
      [
        { client: 5, items: [{ parent: [6, 0] }] },
        { client: 6, items: [{ parent: [5, 0] }] },
      ],
      [{ client: 5, items: [[5, 0]] }],
      [{ client: 5, items: [[5, 1], null] }],
    ]
    for (const blocks of cases) {
      expect(checkMetaUpdate(new Y.Doc(), encodeUpdate(blocks))).not.toBeNull()
    }
    const ok = encodeUpdate([
      { client: 5, items: [[6, 0]] },
      { client: 6, items: [null] },
    ])
    expect(checkMetaUpdate(new Y.Doc(), ok)).toBeNull()
    const doc = new Y.Doc()
    Y.applyUpdate(doc, ok)
    expect(doc.store.pendingStructs).toBeNull()
  })
})

/** A client's items on key "k" of the comments, each after an origin or first. */
interface Block {
  client: number
  clock?: number
  /** Each after an origin, or first under key "k" of a parent, or of the comments. */
  items: Array<[number, number] | { parent: [number, number] } | null>
}

/** Writes blocks as a V1 update, as no honest peer would. */
function encodeUpdate(blocks: Block[]): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, blocks.length)
  for (const b of blocks) {
    encoding.writeVarUint(e, b.items.length)
    encoding.writeVarUint(e, b.client)
    encoding.writeVarUint(e, b.clock ?? 0)
    for (const it of b.items) {
      if (Array.isArray(it)) {
        encoding.writeUint8(e, 0x80 | 8)
        encoding.writeVarUint(e, it[0])
        encoding.writeVarUint(e, it[1])
      } else if (it) {
        encoding.writeUint8(e, 0x20 | 8)
        encoding.writeVarUint(e, 0)
        encoding.writeVarUint(e, it.parent[0])
        encoding.writeVarUint(e, it.parent[1])
        encoding.writeVarString(e, 'k')
      } else {
        encoding.writeUint8(e, 0x20 | 8)
        encoding.writeVarUint(e, 1)
        encoding.writeVarString(e, 'comments')
        encoding.writeVarString(e, 'k')
      }
      encoding.writeVarUint(e, 1)
      encoding.writeAny(e, 1)
    }
  }
  encoding.writeVarUint(e, 0)
  return encoding.toUint8Array(e)
}
