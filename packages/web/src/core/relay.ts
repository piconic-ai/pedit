/**
 * Where a relay's endpoints are. The core is given the relay as a URL and
 * never reads the page's own: the relay's editor passes its own origin, and
 * a component on another app's domain passes the relay it talks to.
 *
 * A path on the relay is kept as a prefix, so `https://x.test/pedit` serves
 * `https://x.test/pedit/api/rooms/<id>/ws`. Its query and fragment are dropped.
 */
function base(relay: URL): string {
  return relay.pathname.replace(/\/+$/, '')
}

/** The room's WebSocket URL: `https:` relays use `wss:`, `http:` relays `ws:`. */
export function socketUrl(relay: URL, id: string): string {
  const scheme = relay.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${relay.host}${base(relay)}/api/rooms/${id}/ws`
}

/** The URL of one encrypted attachment in the room's blob store. */
export function blobUrl(relay: URL, id: string, blobId: string): string {
  return `${relay.origin}${base(relay)}/api/rooms/${id}/blobs/${blobId}`
}
