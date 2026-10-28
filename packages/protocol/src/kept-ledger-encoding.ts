import { utf8 } from './access-crypto.ts'
import { MAX_KEPT_CHECKPOINT_PAYLOAD } from './kept-checkpoint.ts'
import { KeptLedger, type KeptReceipt } from './kept-ledger.ts'

const DOMAIN = utf8.encode('pedit/v6/ledger\0')
const HEADER = DOMAIN.length + 4
const ITEM = 74
const MAX_ITEMS = Math.floor((MAX_KEPT_CHECKPOINT_PAYLOAD - HEADER) / ITEM)
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
const unhex = (value: string): Uint8Array =>
  Uint8Array.from(value.match(/../g) ?? [], (part) => Number.parseInt(part, 16))
const tier = (access: KeptReceipt['access']): number => (access === 'edit' ? 0 : 1)

// The caller must budget for other checkpoint data and save the ledger with its
// document atomically; exceeding capacity must not discard receipts.
export function encodeKeptLedger(ledger: KeptLedger): Uint8Array {
  const items = ledger.snapshot()
  if (items.length > MAX_ITEMS) throw new Error('ledger exceeds checkpoint capacity')
  items.sort(
    (a, b) =>
      tier(a.access) - tier(b.access) ||
      (a.sender < b.sender ? -1 : a.sender > b.sender ? 1 : a.sequence - b.sequence),
  )
  const out = new Uint8Array(HEADER + items.length * ITEM)
  out.set(DOMAIN)
  const view = new DataView(out.buffer)
  view.setUint32(DOMAIN.length, items.length)
  let at = HEADER
  for (const item of items) {
    out[at++] = tier(item.access)
    out.set(unhex(item.sender), at)
    at += 32
    view.setBigUint64(at, BigInt(item.sequence))
    at += 8
    out.set(unhex(item.digest), at)
    at += 32
    out[at++] = item.outcome === 'rejected' ? 1 : 0
  }
  return out
}

// Authenticate the enclosing checkpoint before decoding the ledger.
export function decodeKeptLedger(limit: number, data: Uint8Array): KeptLedger {
  const bad = () => new Error('invalid ledger encoding')
  if (
    data.length < HEADER ||
    data.length > MAX_KEPT_CHECKPOINT_PAYLOAD ||
    !DOMAIN.every((v, i) => data[i] === v)
  )
    throw bad()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const count = view.getUint32(DOMAIN.length)
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    count > limit ||
    count > MAX_ITEMS ||
    data.length !== HEADER + count * ITEM
  )
    throw bad()
  const items: KeptReceipt[] = []
  let previous: Uint8Array | undefined
  for (let at = HEADER; at < data.length; at += ITEM) {
    const raw = data.subarray(at, at + ITEM)
    const id = raw.subarray(0, 41)
    if (previous && !less(previous, id)) throw bad()
    items.push(decodeReceipt(raw, view.getBigUint64(at + 33)))
    previous = id
  }
  return KeptLedger.restore(limit, items)
}

function decodeReceipt(raw: Uint8Array, sequence: bigint): KeptReceipt {
  const access = raw[0] === 0 ? 'edit' : raw[0] === 1 ? 'comment' : null
  const outcome = raw[73] === 0 ? 'applied' : raw[73] === 1 ? 'rejected' : null
  if (!access || !outcome || sequence > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('invalid ledger encoding')
  return {
    access,
    sender: hex(raw.subarray(1, 33)),
    sequence: Number(sequence),
    digest: hex(raw.subarray(41, 73)),
    outcome,
  }
}

function less(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0)
  }
  return false
}
