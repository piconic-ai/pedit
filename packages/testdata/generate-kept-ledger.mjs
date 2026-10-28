import { createHash } from 'node:crypto'

const items = [
  ['edit', 1, 2, 'one', 'gap', null],
  ['edit', 1, 1, 'one', 'next', 'applied'],
  ['edit', 1, 1, 'one', 'duplicate', null],
  ['edit', 1, 1, 'other', 'conflict', null],
  ['edit', 1, 2, 'two', 'next', 'rejected'],
  ['comment', 1, 1, 'three', 'next', 'applied'],
  ['edit', 2, 1, 'four', 'next', 'applied'],
  ['edit', 2, 2, 'five', 'full', null],
  ['edit', 1, 2, 'two', 'duplicate', null],
]
const vectors = items.map(([access, seed, sequence, message, decision, commit]) => {
  const sender = Buffer.alloc(32, seed)
  const payload = Buffer.from(message)
  const fields = Buffer.alloc(12)
  fields.writeBigUInt64BE(BigInt(sequence))
  fields.writeUInt32BE(payload.length, 8)
  const digest = createHash('sha256')
    .update('pedit/v6/operation\0')
    .update(Buffer.from([access === 'edit' ? 0 : 1]))
    .update(sender)
    .update(fields)
    .update(payload)
    .digest('hex')
  return { access, sender: sender.toString('hex'), sequence, message, decision, commit, digest }
})
process.stdout.write(`${JSON.stringify({ limit: 4, vectors }, null, 2)}\n`)
