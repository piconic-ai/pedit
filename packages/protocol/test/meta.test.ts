import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
// The Go side checks its own against the same file (internal/meta/check_test.go).
import limits from '../../testdata/meta-limits.json'
import { checkMetaUpdate, META_LIMITS } from '../src/index.ts'

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
})
