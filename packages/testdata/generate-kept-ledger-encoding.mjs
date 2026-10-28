import { createCipheriv, createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const fixture = JSON.parse(
  readFileSync(new URL('./kept-ledger-vectors.json', import.meta.url), 'utf8'),
)
const items = fixture.vectors
  .filter((v) => v.commit)
  .map((v) => ({
    access: v.access,
    sender: v.sender,
    sequence: v.sequence,
    digest: v.digest,
    outcome: v.commit,
  }))
items.sort(
  (a, b) =>
    (a.access === 'edit' ? 0 : 1) - (b.access === 'edit' ? 0 : 1) ||
    Buffer.compare(Buffer.from(a.sender, 'hex'), Buffer.from(b.sender, 'hex')) ||
    a.sequence - b.sequence,
)
const header = Buffer.alloc(4)
header.writeUInt32BE(items.length)
const encoded = Buffer.concat([
  Buffer.from('pedit/v6/ledger\0'),
  header,
  ...items.map((item) => {
    const sequence = Buffer.alloc(8)
    sequence.writeBigUInt64BE(BigInt(item.sequence))
    return Buffer.concat([
      Buffer.from([item.access === 'edit' ? 0 : 1]),
      Buffer.from(item.sender, 'hex'),
      sequence,
      Buffer.from(item.digest, 'hex'),
      Buffer.from([item.outcome === 'applied' ? 0 : 1]),
    ])
  }),
])
const access = JSON.parse(
  readFileSync(new URL('./kept-access-vectors.json', import.meta.url), 'utf8'),
)
const epoch = Buffer.alloc(32, 5)
const metadata = Buffer.alloc(20)
metadata.writeBigUInt64BE(1n, 0)
metadata.writeBigUInt64BE(9n, 8)
metadata.writeUInt32BE(encoded.length, 16)
const checkpointBody = Buffer.concat([
  Buffer.from('pedit/v6/checkpoint\0'),
  Buffer.from(access.roomId),
  epoch,
  metadata,
  encoded,
])
const host = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8',
})
const iv = Buffer.from('000102030405060708090a0b', 'hex')
const cipher = createCipheriv('aes-256-gcm', Buffer.from(access.frameKey, 'base64url'), iv)
const checkpoint = Buffer.concat([
  iv,
  cipher.update(Buffer.concat([checkpointBody, sign(null, checkpointBody, host)])),
  cipher.final(),
  cipher.getAuthTag(),
])
process.stdout.write(
  `${JSON.stringify({ items, encoded: encoded.toString('base64url'), roomId: access.roomId, epoch: epoch.toString('base64url'), generation: 1, cutoff: 9, checkpoint: checkpoint.toString('base64url') }, null, 2)}\n`,
)
