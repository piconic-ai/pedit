import { describe, expect, it } from 'vitest'
import fixtures from '../../testdata/kept-ledger-vectors.json'
import { KeptLedger } from '../src/kept-ledger.ts'
import type { KeptRecord } from '../src/kept-record.ts'

function record(item: (typeof fixtures.vectors)[number]): KeptRecord {
  if (item.access !== 'edit' && item.access !== 'comment') throw new Error('invalid fixture')
  return {
    access: item.access,
    sender: Uint8Array.from(Buffer.from(item.sender, 'hex')),
    sequence: item.sequence,
    message: new TextEncoder().encode(item.message),
  }
}

describe('kept ledger', () => {
  it('classifies the shared operation vectors and returns a new ledger', async () => {
    let ledger = KeptLedger.empty(fixtures.limit)
    for (const [i, item] of fixtures.vectors.entries()) {
      const op = record(item)
      const plan = await ledger.inspect(op)
      expect(plan.decision).toBe(item.decision)
      expect(plan.digest).toBe(item.digest)
      if (item.commit === 'applied' || item.commit === 'rejected') {
        const old = ledger
        ledger = ledger.commit(plan, item.commit)
        expect(() => ledger.commit(plan, 'applied')).toThrow()
        expect((await old.inspect(op)).decision).toBe('next')
      }
      const snapshot = ledger.snapshot()
      const restored = KeptLedger.restore(fixtures.limit, snapshot)
      const observed = await restored.inspect(op)
      if (item.commit) expect(observed.decision).toBe('duplicate')
      if (snapshot.length) {
        snapshot[0]!.sequence = 2
        expect(() => KeptLedger.restore(fixtures.limit, snapshot)).toThrow()
        expect((await restored.inspect(op)).decision).toBe(observed.decision)
      }
      if (i === 8) expect(plan.outcome).toBe('rejected')
    }
  })
  it('rejects invalid input, fabricated plans and concurrent stale plans', async () => {
    expect(() => KeptLedger.empty(0)).toThrow()
    const ledger = KeptLedger.empty(1)
    const op = record(fixtures.vectors[1]!)
    await expect(ledger.inspect({ ...op, sequence: 0 })).rejects.toThrow()
    await expect(ledger.inspect({ ...op, sequence: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow()
    await expect(ledger.inspect({ ...op, sender: new Uint8Array(31) })).rejects.toThrow()
    await expect(ledger.inspect({ ...op, message: new Uint8Array() })).rejects.toThrow()
    const first = await ledger.inspect(op)
    const competing = await ledger.inspect({ ...op, message: new TextEncoder().encode('other') })
    expect(() => ledger.commit({ ...first }, 'applied')).toThrow()
    const next = ledger.commit(first, 'applied')
    expect(() => next.commit(competing, 'applied')).toThrow()
    expect((await next.inspect(op)).decision).toBe('duplicate')
  })
  it('requires serialized or compare-and-swap saves across senders', async () => {
    const base = KeptLedger.empty(2)
    const first = record(fixtures.vectors[1]!)
    const second = {
      ...first,
      sender: new Uint8Array(32).fill(2),
      message: new TextEncoder().encode('second'),
    }
    const firstPlan = await base.inspect(first)
    const secondPlan = await base.inspect(second)
    const firstResult = base.commit(firstPlan, 'applied')
    const secondResult = base.commit(secondPlan, 'applied')
    expect((await secondResult.inspect(first)).decision).toBe('next')
    expect(() => firstResult.commit(secondPlan, 'applied')).toThrow()
    const fresh = await firstResult.inspect(second)
    const combined = firstResult.commit(fresh, 'applied')
    expect((await combined.inspect(first)).decision).toBe('duplicate')
    expect((await combined.inspect(second)).decision).toBe('duplicate')
  })

  it('rejects plans from another history or restored ledger', async () => {
    const first = record(fixtures.vectors[1]!)
    const other = { ...first, message: new TextEncoder().encode('different') }
    const emptyA = KeptLedger.empty(3)
    const a = emptyA.commit(await emptyA.inspect(first), 'applied')
    const b = emptyA.commit(await emptyA.inspect(other), 'applied')
    const next = { ...first, sequence: 2 }
    const plan = await a.inspect(next)
    expect(() => b.commit(plan, 'applied')).toThrow()
    expect(() => KeptLedger.restore(3, a.snapshot()).commit(plan, 'applied')).toThrow()
    expect(() => b.commit(plan, 'rejected')).toThrow()
    const fresh = await b.inspect(next)
    expect(b.commit(fresh, 'applied').snapshot()).toHaveLength(2)
  })
  it('snapshots mutable inputs before hashing', async () => {
    const ledger = KeptLedger.empty(1)
    const op = record(fixtures.vectors[1]!)
    const pending = ledger.inspect(op)
    op.sender.fill(0)
    op.message.fill(0)
    expect((await pending).digest).toBe(fixtures.vectors[1]?.digest)
  })
})
