import { buf, utf8 } from './access-crypto.ts'
import { decrypt } from './cipher.ts'
import { MAX_FRAME_BYTES } from './frame.ts'
import { isKeptRoomKeys, type KeptRoomKeys } from './kept-access.ts'

const DOMAIN = utf8.encode('pedit/v6/checkpoint\0')
const HEADER_BYTES = DOMAIN.length + 22 + 32 + 8 + 8 + 4
const SIGNATURE_BYTES = 64
const ENCRYPTION_BYTES = 12 + 16
const MAX_PAYLOAD = MAX_FRAME_BYTES - HEADER_BYTES - SIGNATURE_BYTES - ENCRYPTION_BYTES

export interface KeptCheckpointContext {
  roomId: string
  epoch: Uint8Array
  generation: number
  cutoff: number
}

function checkpointHeader(context: KeptCheckpointContext, payloadSize: number): Uint8Array {
  if (
    context.roomId.length !== 22 ||
    !/^[A-Za-z0-9_-]{22}$/.test(context.roomId) ||
    context.epoch.length !== 32 ||
    context.epoch.every((b) => b === 0) ||
    !Number.isSafeInteger(context.generation) ||
    context.generation < 1 ||
    !Number.isSafeInteger(context.cutoff) ||
    context.cutoff < 0 ||
    payloadSize < 1 ||
    payloadSize > MAX_PAYLOAD
  ) {
    throw new Error('invalid checkpoint context or size')
  }
  const header = new Uint8Array(HEADER_BYTES)
  let at = 0
  header.set(DOMAIN, at)
  at += DOMAIN.length
  header.set(utf8.encode(context.roomId), at)
  at += 22
  header.set(context.epoch, at)
  at += 32
  const view = new DataView(header.buffer)
  view.setBigUint64(at, BigInt(context.generation))
  at += 8
  view.setBigUint64(at, BigInt(context.cutoff))
  at += 8
  view.setUint32(at, payloadSize)
  return header
}

export async function openKeptCheckpoint(
  keys: KeptRoomKeys,
  context: KeptCheckpointContext,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (!isKeptRoomKeys(keys)) throw new Error('invalid checkpoint')
  const expected = { ...context, epoch: Uint8Array.from(context.epoch) }
  const frameKey = keys.frameKey
  const hostKey = keys.hostKey
  if (
    keys.version !== 'v6' ||
    keys.roomId !== expected.roomId ||
    ciphertext.length > MAX_FRAME_BYTES
  ) {
    throw new Error('invalid checkpoint')
  }
  const input = Uint8Array.from(ciphertext)
  let plain: Uint8Array
  try {
    plain = await decrypt(frameKey, input)
  } catch {
    throw new Error('invalid checkpoint')
  }
  if (plain.length < HEADER_BYTES + SIGNATURE_BYTES) throw new Error('invalid checkpoint')
  const end = plain.length - SIGNATURE_BYTES
  const header = checkpointHeader(expected, end - HEADER_BYTES)
  if (!header.every((byte, i) => plain[i] === byte)) throw new Error('invalid checkpoint')
  const valid = await crypto.subtle.verify(
    'Ed25519',
    hostKey,
    buf(plain.subarray(end)),
    buf(plain.subarray(0, end)),
  )
  if (!valid) throw new Error('invalid checkpoint')
  return plain.slice(HEADER_BYTES, end)
}
