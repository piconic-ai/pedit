import * as Y from 'yjs'

/**
 * Limits on a metadata doc, the comments of a file (#121), which every peer
 * applies to each update it receives, as internal/meta/check.go does: a
 * hostile key holder cannot make a peer hold more than it can send, since the
 * relay closes the socket of a peer whose frame passes 1 MiB.
 * Both check theirs against packages/testdata/meta-limits.json.
 */
export const META_LIMITS = {
  maxDocBytes: 512 * 1024,
  maxClientClock: 1 << 16,
} as const

/**
 * Tells why an update received for `doc`, a metadata doc, must not be
 * applied, or returns null. It applies it to a copy of `doc` first, and
 * refuses it when part of it would wait for updates not received yet (Yjs
 * keeps those as pending, and sends them on with the doc, past every check),
 * when it takes one client past maxClientClock operations, or when the doc
 * would pass maxDocBytes. An honest update refused for a gap comes back with
 * the answer to this peer's next sync step 1.
 */
export function checkMetaUpdate(doc: Y.Doc, update: Uint8Array): string | null {
  const copy = new Y.Doc()
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
    Y.applyUpdate(copy, update)
  } catch {
    return 'not a valid update'
  }
  if (copy.store.pendingStructs !== null || copy.store.pendingDs !== null) {
    return 'it skips updates not received yet'
  }
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(copy))) {
    if (clock > META_LIMITS.maxClientClock) {
      return `client ${client} passed ${META_LIMITS.maxClientClock} operations`
    }
  }
  const size = Y.encodeStateAsUpdate(copy).length
  if (size > META_LIMITS.maxDocBytes) return `the comments would take ${size} bytes`
  return null
}
