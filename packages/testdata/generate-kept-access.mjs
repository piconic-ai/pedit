import { createPrivateKey, createPublicKey, hkdfSync, sign } from 'node:crypto'

const b64 = (bytes) => Buffer.from(bytes).toString('base64url')
const kdf = (secret, info) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32))
const privateKey = (seed) =>
  createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  })
const pub = (seed) =>
  createPublicKey(privateKey(seed)).export({ format: 'der', type: 'spki' }).subarray(-32)

const secret = Buffer.alloc(32, 3)
const host = pub(Buffer.alloc(32, 7))
const roomId = 'AAECAwQFBgcICQoLDA0ODw'
const editKey = pub(kdf(secret, 'pedit v6 edit sign'))
const comment = kdf(secret, 'pedit v6 comment')
const commentKey = pub(kdf(comment, 'pedit v6 comment sign'))
const read = kdf(comment, 'pedit v6 read')
const length = Buffer.alloc(2)
length.writeUInt16BE(Buffer.byteLength(roomId))
const frameKey = kdf(
  read,
  Buffer.concat([
    Buffer.from('pedit v6 frame'),
    length,
    Buffer.from(roomId),
    editKey,
    commentKey,
    host,
  ]),
)
const vector = {
  roomId,
  hostKey: b64(host),
  edit: `v6.e.${b64(Buffer.concat([secret, host]))}`,
  comment: `v6.c.${b64(Buffer.concat([comment, editKey, host]))}`,
  read: `v6.r.${b64(Buffer.concat([read, editKey, commentKey, host]))}`,
  editKey: b64(editKey),
  commentKey: b64(commentKey),
  frameKey: b64(frameKey),
  editAdmission: b64(kdf(secret, 'pedit v6 edit admission')),
  commentAdmission: b64(
    kdf(
      comment,
      Buffer.concat([
        Buffer.from('pedit v6 comment admission'),
        length,
        Buffer.from(roomId),
        editKey,
        commentKey,
        host,
      ]),
    ),
  ),
  readAdmission: b64(kdf(frameKey, 'pedit v5 read admission')),
  hostSignature: b64(
    sign(null, Buffer.from('kept checkpoint vector'), privateKey(Buffer.alloc(32, 7))),
  ),
  invalidPublicKeys: [
    { name: 'identity', key: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    { name: 'signed identity', key: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIA' },
    { name: 'order two', key: '7P_______________________________________38' },
    { name: 'noncanonical identity', key: '7v_______________________________________38' },
    { name: 'base point plus order two', key: 'lZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZk' },
  ],
}
process.stdout.write(`${JSON.stringify(vector, null, 2)}\n`)
