import * as encoding from 'lib0/encoding'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
// The Go side checks its own against the same file (internal/meta/check_test.go).
import limits from '../../testdata/meta-limits.json'
// internal/meta/check_test.go checks the Go measure against the same file.
import measured from '../../testdata/meta-measure.json'
import { checkMetaUpdate, META_LIMITS, metaDocSize } from '../src/index.ts'

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
    expect(META_LIMITS).toEqual(limits)
  })

  it('measures a doc as the Go side does', () => {
    // Made by Yjs, with an UndoManager's run of values and a deleted thread.
    const state = Uint8Array.from(atob(measured.state), (c) => c.charCodeAt(0))
    expect(checkMetaUpdate(new Y.Doc(), state)).toBeNull()
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    expect(metaDocSize(doc)).toBe(measured.measure)
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
    // The host's own 65,537 operations make it too large by its measure, but
    // the guest's update is not refused for them.
    expect(checkMetaUpdate(host, Y.encodeStateAsUpdate(guest))?.reason ?? '').not.toMatch(
      /operations/,
    )
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
    const most = Math.floor(Math.sqrt(META_LIMITS.maxListWork))
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
    const n = 768 // a list of 1,536: more work than maxListWork
    const chain: Block = { client: 1, items: [] }
    for (let i = 0; i < n; i++) chain.items.push(i > 0 ? [1, i - 1] : null)
    const blocks = [chain]
    for (let i = 0; i < n; i++) blocks.push({ client: 1000 + i, items: [[1, i]] })
    expect(checkMetaUpdate(new Y.Doc(), encodeUpdate(blocks))?.reason).toMatch(/lists/)
  })

  it('weighs a run of values by its length', () => {
    // From review: an UndoManager keeps overwritten values, which Yjs sends
    // as one run; one of many counted as one item.
    const peer = new Y.Doc()
    const comments = peer.getMap('comments')
    new Y.UndoManager(comments)
    for (let i = 0; i < 5; i++) comments.set('resolved', i % 2 === 0)
    expect(checkMetaUpdate(new Y.Doc(), Y.encodeStateAsUpdate(peer))).toBeNull()
    const e = encoding.createEncoder()
    for (const n of [1, 1, 7, 0]) encoding.writeVarUint(e, n)
    encoding.writeUint8(e, 0x20 | 8)
    encoding.writeVarUint(e, 1)
    encoding.writeVarString(e, 'comments')
    encoding.writeVarString(e, 'k')
    encoding.writeVarUint(e, 1100)
    for (let i = 0; i < 1100; i++) encoding.writeAny(e, i)
    encoding.writeVarUint(e, 0)
    expect(checkMetaUpdate(new Y.Doc(), encoding.toUint8Array(e))?.reason).toMatch(/lists/)
  })

  it('takes the state of a large doc, again and anew', () => {
    // From review: a doc near the limit, with many deletions, was refused as
    // a whole by a new peer, and its state again by peers that had it.
    const host = new Y.Doc()
    const m = host.getMap('comments')
    for (let i = 0; i < 31; i++) m.set(`q${i}`, 'x'.repeat(20000))
    for (let i = 0; i < 6000; i++) m.set(`k${i}`, i)
    for (let i = 0; i < 3000; i++) m.delete(`k${2 * i}`)
    const state = Y.encodeStateAsUpdate(host)
    expect(state.length).toBeGreaterThan(META_LIMITS.maxDocBytes / 2)
    expect(checkMetaUpdate(new Y.Doc(), state)).toBeNull()
    expect(checkMetaUpdate(host, state)).toBeNull()
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
      // Client 5's second item follows its first, which is in 6's, in 5's
      // second: a cycle only with the order of clocks.
      [
        { client: 5, items: [{ parent: [6, 0] }, null] },
        { client: 6, items: [{ parent: [5, 1] }] },
      ],
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

describe('the measure of comments', () => {
  it('counts the tag of an integer', () => {
    // From review: integers were counted without it, so a doc of them
    // measured half its size.
    const doc = new Y.Doc()
    doc.getMap('comments').set('zeros', new Array(3000).fill(0))
    expect(Y.encodeStateAsUpdate(doc).length).toBeLessThanOrEqual(metaDocSize(doc))
    expect(metaDocSize(doc)).toBeGreaterThan(6000)
  })

  it('refuses a concurrent set that would take the doc past the limit', () => {
    // From review: k=false and padding to just under the limit, then another
    // client's k=true, with no deletions, passed and took the doc past it.
    const padded = (n: number) => {
      const doc = new Y.Doc()
      doc.transact(() => {
        doc.getMap('comments').set('k', false)
        doc.getMap('comments').set('pad', 'x'.repeat(n))
      })
      return doc
    }
    const n = META_LIMITS.maxDocBytes - 300
    const host = padded(n + META_LIMITS.maxDocBytes - 100 - metaDocSize(padded(n)))
    expect(metaDocSize(host)).toBe(META_LIMITS.maxDocBytes - 100)
    const peer = new Y.Doc()
    peer.getMap('comments').set('k', true)
    expect(checkMetaUpdate(host, Y.encodeStateAsUpdate(peer))).not.toBeNull()
  })

  it('refuses an item inside a run that would take the doc past the limit', () => {
    // From review: a run of a long string and false, and another client's
    // item after its first value, split it into pieces that measured more
    // than the run, with no deletions at all.
    const host = new Y.Doc()
    host.getMap('comments').set('pad', 'x'.repeat(META_LIMITS.maxDocBytes - 1200))
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 2)
    for (const v of [1, 7, 0]) encoding.writeVarUint(e, v)
    encoding.writeUint8(e, 0x20 | 8)
    encoding.writeVarUint(e, 1)
    encoding.writeVarString(e, 'comments')
    encoding.writeVarString(e, 'k')
    encoding.writeVarUint(e, 2)
    encoding.writeAny(e, 'x'.repeat(1000))
    encoding.writeAny(e, false)
    for (const v of [1, 8, 0]) encoding.writeVarUint(e, v)
    encoding.writeUint8(e, 0x80 | 8)
    encoding.writeVarUint(e, 7)
    encoding.writeVarUint(e, 0)
    encoding.writeVarUint(e, 1)
    encoding.writeAny(e, true)
    encoding.writeVarUint(e, 0)
    const update = encoding.toUint8Array(e)
    const refused = checkMetaUpdate(host, update) !== null
    Y.applyUpdate(host, update)
    if (!refused) expect(metaDocSize(host)).toBeLessThanOrEqual(META_LIMITS.maxDocBytes)
    expect(refused).toBe(true)
  })

  it('foresees what concurrent sets delete', () => {
    // Peers that seldom catch up set values and maps under the same keys.
    // Every doc the host comes to, a new peer takes whole, and it measures
    // no less than Yjs writes.
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed % n
    }
    const host = new Y.Doc()
    const peers = [new Y.Doc(), new Y.Doc(), new Y.Doc()]
    for (let round = 0; round < 200; round++) {
      const p = peers[rand(peers.length)]!
      if (rand(4) === 0) Y.applyUpdate(p, Y.encodeStateAsUpdate(host, Y.encodeStateVector(p)))
      const before = Y.encodeStateVector(p)
      p.transact(() => {
        const m = p.getMap('comments')
        for (let i = 0; i <= rand(4); i++) {
          const key = `k${rand(6)}`
          const op = rand(4)
          if (op === 0) m.delete(key)
          else if (op === 1) {
            const inner = new Y.Map()
            m.set(key, inner)
            inner.set('body', `${round}`)
            inner.set('n', rand(1000))
          } else m.set(key, rand(1 << 20))
        }
      })
      const update = Y.encodeStateAsUpdate(p, before)
      expect(checkMetaUpdate(host, update)).toBeNull()
      Y.applyUpdate(host, update)
      const state = Y.encodeStateAsUpdate(host)
      expect(state.length).toBeLessThanOrEqual(metaDocSize(host))
      expect(checkMetaUpdate(new Y.Doc(), state)).toBeNull()
    }
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
