import * as Y from 'yjs'
import { MAX_FRAME_BYTES } from './frame.ts'
import type { Refusal } from './room.ts'

/**
 * Limits on a metadata doc, the comments of a file (#121), which every peer
 * applies to each update it receives, as internal/meta/check.go does: a
 * hostile key holder cannot make a peer hold more than it can send, since the
 * relay closes the socket of a peer whose frame passes 1 MiB.
 * Both check theirs against packages/testdata/meta-limits.json.
 */
export const META_LIMITS = {
  /**
   * So the doc's whole state fits the frame it is sent in, with room for the
   * frame's headers. The host shares no comments larger.
   */
  maxDocBytes: MAX_FRAME_BYTES - 4096,
  maxClientClock: 1 << 16,
} as const

/**
 * Tells why an update received for `doc`, a metadata doc, must not be
 * applied, or returns null. It applies it to a copy of `doc` first, and
 * refuses it when:
 * - part of it, structs or deletions, would wait for updates not received
 *   yet (Yjs keeps those as pending, and sends them on with the doc, past
 *   every check). This refusal is for now: the client asks the room again,
 *   and an honest peer's updates come back whole;
 * - it takes one of its clients past maxClientClock operations;
 * - the doc would pass maxDocBytes.
 */
export function checkMetaUpdate(doc: Y.Doc, update: Uint8Array): Refusal | null {
  const copy = new Y.Doc()
  let clocks: Map<number, number>
  try {
    clocks = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update))
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    Y.applyUpdate(copy, update)
  } catch {
    return { reason: 'not a valid update' }
  }
  if (copy.store.pendingStructs !== null || copy.store.pendingDs !== null) {
    return { reason: 'it needs updates not received yet', retryLater: true }
  }
  for (const [client, clock] of clocks) {
    if (clock > META_LIMITS.maxClientClock) {
      return { reason: `client ${client} passed ${META_LIMITS.maxClientClock} operations` }
    }
  }
  const size = Y.encodeStateAsUpdate(copy).length
  if (size > META_LIMITS.maxDocBytes) return { reason: `the comments would take ${size} bytes` }
  return null
}
