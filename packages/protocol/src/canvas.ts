import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'

/**
 * Canvas messages carry JSON someone edited by hand in a canvas room. The
 * browser does not change the shared structure itself: it sends what it
 * started from and what it made, and the host applies the change the way it
 * applies an edit to the file made outside pedit.
 *
 * - edit: someone changed the canvas from `base` to `next`, both JSON Canvas text
 * - applied: the host applied the edit with this `id`
 * - rejected: the host did not apply the edit with this `id`, for `reason`
 *
 * An edit's `id` must be unique within the room, such as a random one: the
 * host applies an id once and answers a repeat, sent again after a
 * reconnect, without applying it, so two guests sharing an id would lose the
 * second edit.
 */
export type CanvasMessage =
  | { kind: 'edit'; id: string; base: string; next: string }
  | { kind: 'applied'; id: string }
  | { kind: 'rejected'; id: string; reason: string }

const KIND = { edit: 0, applied: 1, rejected: 2 } as const

/** An edit carries two copies of the canvas and must fit in one relayed frame (MAX_FRAME_BYTES). */
export const MAX_CANVAS_EDIT_BYTES = 960 * 1024
const MAX_ID = 64
const MAX_REASON = 16 * 1024

const utf8 = new TextEncoder()
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true })

export function encodeCanvas(m: CanvasMessage): Uint8Array {
  validate(m)
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, KIND[m.kind])
  encoding.writeVarString(encoder, m.id)
  switch (m.kind) {
    case 'edit':
      encoding.writeVarString(encoder, m.base)
      encoding.writeVarString(encoder, m.next)
      break
    case 'rejected':
      encoding.writeVarString(encoder, m.reason)
      break
  }
  return encoding.toUint8Array(encoder)
}

/**
 * A canvas kind this version does not know, from a newer peer. Clients skip
 * such messages instead of reporting them.
 */
export class UnknownCanvasKindError extends Error {
  // Not a parameter property: Node.js strips types but cannot run those.
  readonly canvasKind: number

  constructor(canvasKind: number) {
    super(`unknown canvas kind: ${canvasKind}`)
    this.name = 'UnknownCanvasKindError'
    this.canvasKind = canvasKind
  }
}

/**
 * Throws on malformed payloads, and UnknownCanvasKindError on kinds this
 * version does not know.
 */
export function decodeCanvas(payload: Uint8Array): CanvasMessage {
  // lib0 can read past the end without complaint, so check around every read.
  const decoder = decoding.createDecoder(payload)
  const read = <T>(fn: () => T): T => {
    if (decoder.pos >= payload.length) throw new Error('truncated canvas message')
    const value = fn()
    if (decoder.pos > payload.length) throw new Error('truncated canvas message')
    return value
  }
  const str = () => fatalUtf8.decode(read(() => decoding.readVarUint8Array(decoder)))

  let m: CanvasMessage
  const kind = read(() => decoding.readVarUint(decoder))
  switch (kind) {
    case KIND.edit:
      m = { kind: 'edit', id: str(), base: str(), next: str() }
      break
    case KIND.applied:
      m = { kind: 'applied', id: str() }
      break
    case KIND.rejected:
      m = { kind: 'rejected', id: str(), reason: str() }
      break
    default:
      throw new UnknownCanvasKindError(kind)
  }
  if (decoder.pos !== payload.length) throw new Error('trailing bytes in canvas message')
  validate(m)
  return m
}

function validate(m: CanvasMessage): void {
  // Limits count UTF-8 bytes, as the Go side does.
  const bytes = (s: string) => utf8.encode(s).length
  const id = bytes(m.id)
  if (id === 0 || id > MAX_ID) throw new Error('invalid canvas message id')
  switch (m.kind) {
    case 'edit':
      if (bytes(m.base) + bytes(m.next) > MAX_CANVAS_EDIT_BYTES) {
        throw new Error('canvas edit too large')
      }
      break
    case 'rejected': {
      const reason = bytes(m.reason)
      if (reason === 0 || reason > MAX_REASON) throw new Error('invalid reason')
      break
    }
  }
}
