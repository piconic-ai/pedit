/**
 * The relay as an http(s) URL without credentials, or null. One check for the
 * element's `relay` attribute and for `reviewCSP`, so they never disagree.
 */
export function parseRelayUrl(value: string | URL | null | undefined): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const web = url.protocol === 'https:' || url.protocol === 'http:'
    return web && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}
