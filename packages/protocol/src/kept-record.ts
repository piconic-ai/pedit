import { ed25519 } from '@noble/curves/ed25519.js'
import { buf, concat, utf8, verifyingKey } from './access-crypto.ts'
import { decrypt, encrypt } from './cipher.ts'
import { MAX_FRAME_BYTES } from './frame.ts'
import { isKeptRoomKeys, type KeptRoomKeys } from './kept-access.ts'

const CERT_DOMAIN = utf8.encode('pedit/v6/sender-cert\0')
const RECORD_DOMAIN = utf8.encode('pedit/v6/durable-frame\0')
const BINDING_DOMAIN = utf8.encode('pedit/v6/room-binding\0')
const CERT_BODY = CERT_DOMAIN.length + 22 + 32 + 1 + 32
const CERT_SIZE = CERT_BODY + 64
const HEADER_SIZE = RECORD_DOMAIN.length + CERT_SIZE + 32 + 8 + 8 + 4
export const MAX_KEPT_RECORD_PAYLOAD = MAX_FRAME_BYTES - HEADER_SIZE - 64 - 28

export interface KeptRecordContext {
  roomId: string
  epoch: Uint8Array
  generation: number
}
export interface KeptRecord {
  access: 'edit' | 'comment'
  sender: Uint8Array
  sequence: number
  message: Uint8Array
}

function validContext(keys: KeptRoomKeys, c: KeptRecordContext): boolean {
  return (
    isKeptRoomKeys(keys) &&
    keys.roomId === c.roomId &&
    c.epoch.length === 32 &&
    c.epoch.some((v) => v !== 0) &&
    Number.isSafeInteger(c.generation) &&
    c.generation > 0
  )
}
function validPublicKey(raw: Uint8Array): boolean {
  try {
    const p = ed25519.Point.fromBytes(raw, false)
    return (
      raw.length === 32 &&
      !p.is0() &&
      p.isTorsionFree() &&
      p.toBytes().every((v, i) => v === raw[i])
    )
  } catch {
    return false
  }
}
async function binding(keys: KeptRoomKeys): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', buf(concat(BINDING_DOMAIN, keys.frameSecret))),
  )
}
function equals(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export async function createKeptSenderCertificate(
  keys: KeptRoomKeys,
  sender: Uint8Array,
): Promise<Uint8Array> {
  sender = Uint8Array.from(sender)
  if (!isKeptRoomKeys(keys) || !keys.signer || !validPublicKey(sender))
    throw new Error('invalid sender certificate')
  const tier = keys.signer.access === 'edit' ? 0 : 1
  const body = concat(
    CERT_DOMAIN,
    utf8.encode(keys.roomId),
    await binding(keys),
    Uint8Array.of(tier),
    sender,
  )
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.signer.key, buf(body)))
  return concat(body, signature)
}

async function openCertificate(
  keys: KeptRoomKeys,
  cert: Uint8Array,
): Promise<{ access: 'edit' | 'comment'; sender: Uint8Array }> {
  const bad = () => new Error('invalid sender certificate')
  if (cert.length !== CERT_SIZE || !equals(cert.subarray(0, CERT_DOMAIN.length), CERT_DOMAIN))
    throw bad()
  let at = CERT_DOMAIN.length
  if (!equals(cert.subarray(at, at + 22), utf8.encode(keys.roomId))) throw bad()
  at += 22
  if (!equals(cert.subarray(at, at + 32), await binding(keys))) throw bad()
  at += 32
  const tier = cert[at++]
  if (tier !== 0 && tier !== 1) throw bad()
  const sender = cert.slice(at, at + 32)
  if (!validPublicKey(sender)) throw bad()
  const key = tier === 0 ? keys.editKey : keys.commentKey
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      key,
      buf(cert.subarray(CERT_BODY)),
      buf(cert.subarray(0, CERT_BODY)),
    ))
  )
    throw bad()
  return { access: tier === 0 ? 'edit' : 'comment', sender }
}

export async function sealKeptRecord(
  keys: KeptRoomKeys,
  context: KeptRecordContext,
  sender: CryptoKey,
  certificate: Uint8Array,
  sequence: number,
  message: Uint8Array,
): Promise<Uint8Array> {
  const c = { ...context, epoch: Uint8Array.from(context.epoch) }
  const cert = Uint8Array.from(certificate)
  const payload = Uint8Array.from(message)
  if (
    !validContext(keys, c) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    payload.length < 1 ||
    payload.length > MAX_KEPT_RECORD_PAYLOAD
  )
    throw new Error('invalid durable record')
  const identity = await openCertificate(keys, cert)
  const fields = new Uint8Array(20)
  const view = new DataView(fields.buffer)
  view.setBigUint64(0, BigInt(c.generation))
  view.setBigUint64(8, BigInt(sequence))
  view.setUint32(16, payload.length)
  const body = concat(RECORD_DOMAIN, cert, c.epoch, fields, payload)
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', sender, buf(body)))
  const verify = await verifyingKey(identity.sender)
  if (!(await crypto.subtle.verify('Ed25519', verify, buf(signature), buf(body))))
    throw new Error('invalid durable record')
  return encrypt(keys.frameKey, concat(body, signature))
}

export async function openKeptRecord(
  keys: KeptRoomKeys,
  context: KeptRecordContext,
  ciphertext: Uint8Array,
): Promise<KeptRecord> {
  const c = { ...context, epoch: Uint8Array.from(context.epoch) }
  const input = Uint8Array.from(ciphertext)
  const bad = () => new Error('invalid durable record')
  if (!validContext(keys, c) || input.length > MAX_FRAME_BYTES) throw bad()
  let body: Uint8Array
  try {
    body = await decrypt(keys.frameKey, input)
  } catch {
    throw bad()
  }
  if (
    body.length < HEADER_SIZE + 65 ||
    !equals(body.subarray(0, RECORD_DOMAIN.length), RECORD_DOMAIN)
  )
    throw bad()
  let at = RECORD_DOMAIN.length
  const identity = await openCertificate(keys, body.slice(at, at + CERT_SIZE))
  at += CERT_SIZE
  if (!equals(body.subarray(at, at + 32), c.epoch)) throw bad()
  at += 32
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const generation = view.getBigUint64(at)
  at += 8
  const sequence = view.getBigUint64(at)
  at += 8
  const length = view.getUint32(at)
  at += 4
  const end = body.length - 64
  if (
    generation !== BigInt(c.generation) ||
    sequence < 1n ||
    sequence > BigInt(Number.MAX_SAFE_INTEGER) ||
    length !== end - at
  )
    throw bad()
  const senderKey = await verifyingKey(identity.sender)
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      senderKey,
      buf(body.subarray(end)),
      buf(body.subarray(0, end)),
    ))
  )
    throw bad()
  return { ...identity, sequence: Number(sequence), message: body.slice(at, end) }
}
