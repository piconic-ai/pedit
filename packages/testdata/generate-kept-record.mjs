import {
  createCipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
} from 'node:crypto'
import { readFileSync } from 'node:fs'

const keys = JSON.parse(
  readFileSync(new URL('./kept-access-vectors.json', import.meta.url), 'utf8'),
)
const privateKey = (seed) =>
  createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  })
const tier = privateKey(
  Buffer.from(
    hkdfSync('sha256', Buffer.alloc(32, 3), Buffer.alloc(0), Buffer.from('pedit v6 edit sign'), 32),
  ),
)
const sender = privateKey(Buffer.alloc(32, 11))
const senderPublic = createPublicKey(sender).export({ format: 'der', type: 'spki' }).subarray(-32)
const frame = Buffer.from(keys.frameKey, 'base64url')
const binding = createHash('sha256').update('pedit/v6/room-binding\0').update(frame).digest()
const certBody = Buffer.concat([
  Buffer.from('pedit/v6/sender-cert\0'),
  Buffer.from(keys.roomId),
  binding,
  Buffer.from([0]),
  senderPublic,
])
const certificate = Buffer.concat([certBody, sign(null, certBody, tier)])
const epoch = Buffer.alloc(32, 5)
const numbers = Buffer.alloc(20)
numbers.writeBigUInt64BE(1n, 0)
numbers.writeBigUInt64BE(9n, 8)
const message = Buffer.from([0, 1, 2, 128, 255])
numbers.writeUInt32BE(message.length, 16)
const body = Buffer.concat([
  Buffer.from('pedit/v6/durable-frame\0'),
  certificate,
  epoch,
  numbers,
  message,
])
const iv = Buffer.from('000102030405060708090a0b', 'hex')
const cipher = createCipheriv('aes-256-gcm', frame, iv)
const ciphertext = Buffer.concat([
  iv,
  cipher.update(Buffer.concat([body, sign(null, body, sender)])),
  cipher.final(),
  cipher.getAuthTag(),
])
const b64 = (b) => b.toString('base64url')
process.stdout.write(
  `${JSON.stringify({ roomId: keys.roomId, epoch: b64(epoch), generation: 1, sequence: 9, sender: b64(senderPublic), certificate: b64(certificate), message: b64(message), ciphertext: b64(ciphertext) }, null, 2)}\n`,
)
