import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
// The Go side checks its own against the same file (internal/meta/check_test.go).
import limits from '../../testdata/meta-limits.json'
import { checkMetaUpdate, MAX_PLACE_ITEMS, META_LIMITS } from '../src/index.ts'

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
    expect(checkMetaUpdate(new Y.Doc(), updates[1] as Uint8Array)).toEqual({
      reason: 'it needs updates not received yet',
      retryLater: true,
    })
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

  it('refuses many items in one place', () => {
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
    expect(checkMetaUpdate(new Y.Doc(), sets(MAX_PLACE_ITEMS))).toBeNull()
    expect(checkMetaUpdate(new Y.Doc(), sets(MAX_PLACE_ITEMS + 1))?.reason).toMatch(/one place/)
    const host = new Y.Doc()
    Y.applyUpdate(host, sets(MAX_PLACE_ITEMS))
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
})
