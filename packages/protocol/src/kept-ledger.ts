import { buf, concat, utf8 } from './access-crypto.ts'
import { type KeptRecord, MAX_KEPT_RECORD_PAYLOAD } from './kept-record.ts'

const inspections = new WeakSet<object>()
const DOMAIN = utf8.encode('pedit/v6/operation\0')
type Outcome = 'applied' | 'rejected'
type Decision = 'next' | 'duplicate' | 'conflict' | 'gap' | 'full'
export type KeptReceipt = {
  access: 'edit' | 'comment'
  sender: string
  sequence: number
  digest: string
  outcome: Outcome
}
export type KeptInspection = Readonly<{
  decision: Decision
  floor: number
  digest: string
  outcome?: Outcome
  access: 'edit' | 'comment'
  sender: string
  sequence: number
}>
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

// The caller verifies signatures and epoch, enforces permissions, and saves the
// returned ledger atomically with the corresponding document update.
export class KeptLedger {
  private constructor(
    private readonly limit: number,
    private readonly receipts: readonly KeptReceipt[],
  ) {}

  static empty(limit: number): KeptLedger {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid ledger limit')
    return new KeptLedger(limit, [])
  }

  // The snapshot must come from an authenticated checkpoint.
  static restore(limit: number, snapshot: readonly KeptReceipt[]): KeptLedger {
    const empty = KeptLedger.empty(limit)
    if (snapshot.length > limit) throw new Error('invalid ledger snapshot')
    const floors = new Map<string, number>()
    const receipts = snapshot.map((r) => {
      const key = `${r.access}:${r.sender}`
      if (
        (r.access !== 'edit' && r.access !== 'comment') ||
        !/^[0-9a-f]{64}$/.test(r.sender) ||
        !/^[0-9a-f]{64}$/.test(r.digest) ||
        (r.outcome !== 'applied' && r.outcome !== 'rejected') ||
        !Number.isSafeInteger(r.sequence) ||
        r.sequence !== (floors.get(key) ?? 0) + 1
      )
        throw new Error('invalid ledger snapshot')
      floors.set(key, r.sequence)
      return { ...r }
    })
    return new KeptLedger(empty.limit, receipts)
  }

  snapshot(): KeptReceipt[] {
    return this.receipts.map((r) => ({ ...r }))
  }

  async inspect(record: KeptRecord): Promise<KeptInspection> {
    const sender = Uint8Array.from(record.sender)
    const message = Uint8Array.from(record.message)
    const { access, sequence } = record
    if (
      (access !== 'edit' && access !== 'comment') ||
      sender.length !== 32 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      message.length < 1 ||
      message.length > MAX_KEPT_RECORD_PAYLOAD
    )
      throw new Error('invalid operation')
    const fields = new Uint8Array(12)
    const view = new DataView(fields.buffer)
    view.setBigUint64(0, BigInt(sequence))
    view.setUint32(8, message.length)
    const bytes = concat(DOMAIN, Uint8Array.of(access === 'edit' ? 0 : 1), sender, fields, message)
    const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf(bytes))))
    const senderId = hex(sender)
    let floor = 0
    let match: KeptReceipt | undefined
    for (const receipt of this.receipts) {
      if (receipt.access !== access || receipt.sender !== senderId) continue
      floor = Math.max(floor, receipt.sequence)
      if (receipt.sequence === sequence) match = receipt
    }
    const decision: Decision = match
      ? match.digest === digest
        ? 'duplicate'
        : 'conflict'
      : sequence !== floor + 1
        ? 'gap'
        : this.receipts.length >= this.limit
          ? 'full'
          : 'next'
    const plan = Object.freeze({
      decision,
      floor,
      digest,
      ...(match ? { outcome: match.outcome } : {}),
      access,
      sender: senderId,
      sequence,
    })
    inspections.add(plan)
    return plan
  }

  commit(plan: KeptInspection, outcome: Outcome): KeptLedger {
    if (
      !inspections.has(plan) ||
      plan.decision !== 'next' ||
      (outcome !== 'applied' && outcome !== 'rejected')
    )
      throw new Error('invalid ledger commit')
    let floor = 0
    for (const receipt of this.receipts) {
      if (receipt.access === plan.access && receipt.sender === plan.sender)
        floor = Math.max(floor, receipt.sequence)
    }
    if (floor !== plan.floor || plan.sequence !== floor + 1 || this.receipts.length >= this.limit)
      throw new Error('stale ledger commit')
    const receipt: KeptReceipt = {
      access: plan.access,
      sender: plan.sender,
      sequence: plan.sequence,
      digest: plan.digest,
      outcome,
    }
    return new KeptLedger(this.limit, [...this.receipts, receipt])
  }
}
