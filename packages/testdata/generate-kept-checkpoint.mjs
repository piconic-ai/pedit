import { createCipheriv, createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'

const keys = JSON.parse(
  readFileSync(new URL('./kept-access-vectors.json', import.meta.url), 'utf8'),
)
const room = Buffer.from(keys.roomId)
const epoch = Buffer.alloc(32, 5)
const generation = Buffer.alloc(8)
generation.writeBigUInt64BE(1n)
const cutoff = Buffer.alloc(8)
cutoff.writeBigUInt64BE(9n)
const payload = Buffer.from([0, 1, 2, 128, 255])
const length = Buffer.alloc(4)
length.writeUInt32BE(payload.length)
const input = Buffer.concat([
  Buffer.from('pedit/v6/checkpoint\0'),
  room,
  epoch,
  generation,
  cutoff,
  length,
  payload,
])
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
  format: 'der',
  type: 'pkcs8',
})
const signature = sign(null, input, privateKey)
const iv = Buffer.from('000102030405060708090a0b', 'hex')
const cipher = createCipheriv('aes-256-gcm', Buffer.from(keys.frameKey, 'base64url'), iv)
const ciphertext = Buffer.concat([
  iv,
  cipher.update(Buffer.concat([input, signature])),
  cipher.final(),
  cipher.getAuthTag(),
])
const b64 = (bytes) => bytes.toString('base64url')
process.stdout.write(
  `${JSON.stringify({ roomId: keys.roomId, epoch: b64(epoch), generation: 1, cutoff: 9, payload: b64(payload), ciphertext: b64(ciphertext) }, null, 2)}\n`,
)
