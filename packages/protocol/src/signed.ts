import type { Access, RoomKeys, Signer } from './access.ts'

/**
 * Editors and commenters sign every frame they send (#122); peers with a
 * read link cannot, and send plain messages. A signed message is
 *
 *   SIGNED || tier || signature || message
 *
 * where `message` is the type byte and payload (encodeMessage) and `tier`
 * says which key signed it: 0 the editors', 1 the commenters'. The
 * signature, Ed25519, covers a context string, the tier, the frame's sender
 * and counter, and `message`, so a signed message cannot be moved to another
 * frame or tier, and a frame replayed from a signer is one a receiver drops
 * (frame.ts). The signature sits inside the encryption: the relay sees none
 * of it. Every peer checks it before reading the message, and what a frame
 * may do follows from the tier that verified, never from the message.
 * Keep in sync with internal/protocol/signed.go.
 */
export const SIGNED = 5
export const SIGNATURE_BYTES = 64
/** What signing adds to a message: the SIGNED byte, the tier and the signature. */
export const SIGNED_OVERHEAD = 2 + SIGNATURE_BYTES

const CONTEXT = new TextEncoder().encode('pedit v5 frame sig')
const TIERS: readonly ('edit' | 'comment')[] = ['edit', 'comment']

// WebCrypto's typings reject views over SharedArrayBuffer; ours never are.
const buf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>

function signingInput(tier: number, header: Uint8Array, message: Uint8Array): Uint8Array {
  const out = new Uint8Array(CONTEXT.length + 1 + header.length + message.length)
  out.set(CONTEXT, 0)
  out[CONTEXT.length] = tier
  out.set(header, CONTEXT.length + 1)
  out.set(message, CONTEXT.length + 1 + header.length)
  return out
}

/**
 * Signs `message` for the frame whose sender and counter are `header`
 * (encodeFrame's first HEADER_BYTES), and returns what the frame carries.
 */
export async function signMessage(
  signer: Signer,
  header: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const tier = TIERS.indexOf(signer.access)
  const signature = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      'Ed25519',
      signer.key,
      buf(signingInput(tier, header, message)),
    ),
  )
  const out = new Uint8Array(SIGNED_OVERHEAD + message.length)
  out[0] = SIGNED
  out[1] = tier
  out.set(signature, 2)
  out.set(message, SIGNED_OVERHEAD)
  return out
}

/** A signed message whose signature does not verify, or names no tier. */
export class BadSignatureError extends Error {
  constructor() {
    super('frame signature does not verify')
    this.name = 'BadSignatureError'
  }
}

/**
 * Reads what a frame carries: a signed message, checked against the key of
 * the tier it names, or a plain one, which speaks for a read link. Returns
 * the access the message speaks for, and the message.
 */
export async function openMessage(
  keys: Pick<RoomKeys, 'editKey' | 'commentKey'>,
  header: Uint8Array,
  data: Uint8Array,
): Promise<{ access: Access; message: Uint8Array }> {
  if (data[0] !== SIGNED) return { access: 'read', message: data }
  const tier = TIERS[data[1] ?? -1]
  if (!tier || data.length <= SIGNED_OVERHEAD) throw new BadSignatureError()
  const message = data.subarray(SIGNED_OVERHEAD)
  const ok = await globalThis.crypto.subtle.verify(
    'Ed25519',
    tier === 'edit' ? keys.editKey : keys.commentKey,
    buf(data.slice(2, SIGNED_OVERHEAD)),
    buf(signingInput(data[1] as number, header, message)),
  )
  if (!ok) throw new BadSignatureError()
  return { access: tier, message }
}
