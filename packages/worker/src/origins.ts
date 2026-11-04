// Per-room origins (docs/design/embedding.md): pages on other domains that the
// host lets into its room.

/** Host-only upgrade header: the page origins the room admits, comma-separated. */
export const ORIGINS_HEADER = 'X-Pedit-Origins'
/**
 * Set by the Worker (never by clients) on a request whose Origin is not the
 * relay's own, to that origin. The Durable Object checks it against the list.
 */
export const FOREIGN_ORIGIN_HEADER = 'X-Pedit-Foreign-Origin'

export const MAX_ORIGINS = 4

// A DNS name or IPv4 address and an optional port: no wildcards, no userinfo.
const HTTPS = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/
const LOCAL = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/

function validOrigin(origin: string): boolean {
  try {
    if (new URL(origin).origin !== origin) return false
  } catch {
    return false
  }
  return HTTPS.test(origin) || LOCAL.test(origin)
}

/**
 * The origins a header lists, or undefined if the list is not allowed: more
 * than MAX_ORIGINS, or one that is not exactly `https://host[:port]` (or
 * `http://localhost:<port>` / `http://127.0.0.1:<port>`). No header, or an
 * empty one, lists none.
 */
export function parseOrigins(header: string | null): string[] | undefined {
  if (header === null || header.trim() === '') return []
  const origins = header.split(',').map((o) => o.trim())
  if (origins.length > MAX_ORIGINS || !origins.every(validOrigin)) return undefined
  return [...new Set(origins)]
}

/** CORS headers for an origin the room admits. */
export function corsHeaders(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
}

/** The answer to a preflight from an origin the room admits. */
export function preflight(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(origin),
      'Access-Control-Allow-Headers': 'X-Pedit-Admission',
      'Access-Control-Allow-Methods': 'GET, PUT',
      'Access-Control-Max-Age': '600',
    },
  })
}
