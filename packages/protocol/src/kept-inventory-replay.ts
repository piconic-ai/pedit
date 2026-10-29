import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import { decodeKeptInventoryUpdate, MAX_INVENTORY_PATHS } from './kept-inventory-update.ts'
import { KeptLedger } from './kept-ledger.ts'
import { type KeptRecord, MAX_KEPT_RECORD_PAYLOAD } from './kept-record.ts'
import { checkKeptTextState } from './kept-text-schema.ts'

const PATH = /^assets\/[0-9a-f]{32}\.(?:png|jpg|gif|webp)$(?![\s\S])/
const REFERENCES = /assets\/[0-9a-f]{32}\.(?:png|jpg|gif|webp)/g
// Deliberately small bound for this isolated prototype, including all updates.
const MAX_REPLAY_BYTES = 1024
const MAX_REPLAY_RECORDS = 64

// The caller must authenticate records and baseline and serialize persistence.
// This checks declared known paths, not inventory or relay completeness.
export async function replayKeptInventory(input: {
  text: Uint8Array
  inventory: readonly string[]
  ledger: KeptLedger
  records: readonly KeptRecord[]
}): Promise<{ text: Uint8Array; inventory: string[]; ledger: KeptLedger }> {
  if (
    input.text.length > MAX_REPLAY_BYTES ||
    input.records.length > MAX_REPLAY_RECORDS ||
    input.inventory.length > MAX_INVENTORY_PATHS ||
    input.records.some((r) => r.sender.length !== 32 || r.message.length > MAX_KEPT_RECORD_PAYLOAD)
  )
    throw new Error('invalid inventory replay')
  const baseline = Uint8Array.from(input.text)
  const records = input.records.map((r) => ({
    ...r,
    sender: Uint8Array.from(r.sender),
    message: Uint8Array.from(r.message),
  }))
  const inventory = [...input.inventory]
  if (
    records.length > MAX_REPLAY_RECORDS ||
    baseline.length > MAX_REPLAY_BYTES ||
    !checkKeptTextState(baseline) ||
    inventory.length > MAX_INVENTORY_PATHS ||
    !inventory.every((p, i) => PATH.test(p) && (i === 0 || (inventory[i - 1] ?? '') < p))
  )
    throw new Error('invalid inventory replay')
  const doc = new Y.Doc({ gc: false })
  let ledger = input.ledger,
    total = baseline.length
  const apply = (update: Uint8Array) => {
    const decoder = decoding.createDecoder(update)
    Y.readUpdate(decoder, doc)
    if (
      decoder.pos !== update.length ||
      doc.store.pendingStructs ||
      doc.store.pendingDs ||
      !checkKeptTextState(Y.encodeStateAsUpdate(doc))
    )
      throw new Error('invalid inventory replay')
  }
  const checkRefs = () => {
    const available = new Set(inventory)
    for (const path of doc.getText('content').toString().match(REFERENCES) ?? [])
      if (!available.has(path)) throw new Error('undeclared attachment')
  }
  try {
    apply(baseline)
    checkRefs()
    for (const record of records) {
      if (record.access !== 'edit') throw new Error('invalid inventory replay tier')
      const operation = decodeKeptInventoryUpdate(record.message)
      const plan = await ledger.inspect(record)
      if (plan.decision === 'duplicate') continue
      if (plan.decision !== 'next') throw new Error('invalid inventory replay sequence')
      total += operation.update.length
      if (total > MAX_REPLAY_BYTES) throw new Error('inventory replay capacity')
      for (const path of operation.additions) if (!inventory.includes(path)) inventory.push(path)
      inventory.sort()
      if (inventory.length > MAX_INVENTORY_PATHS) throw new Error('inventory replay capacity')
      apply(operation.update)
      checkRefs()
      ledger = ledger.commit(plan, 'applied')
    }
    return { text: Y.encodeStateAsUpdate(doc), inventory, ledger }
  } finally {
    doc.destroy()
  }
}
