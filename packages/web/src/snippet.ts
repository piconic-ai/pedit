// Fetches the text a snippet embed shows (a source file on GitHub, say), within
// limits: no cookies or referrer, a time limit, a byte limit enforced while the
// body arrives, and text only. The preview renders the lines as text, never as
// markup (preview.ts).

/** How long a snippet may take to arrive, in milliseconds. */
export const SNIPPET_TIMEOUT = 10_000
/** The largest file fetched, in bytes. */
export const SNIPPET_MAX_BYTES = 1024 * 1024
/** The most lines shown; the rest of a longer selection is left out. */
export const SNIPPET_MAX_LINES = 5000

/** Why a snippet could not be shown. */
export type SnippetFailure =
  | { reason: 'network' }
  | { reason: 'status'; status: number }
  | { reason: 'too-large' }
  | { reason: 'timeout' }
  | { reason: 'binary' }
  | { reason: 'range'; total: number }

/** The lines to show, numbered from `from`, and whether more were left out. */
export type SnippetText = { from: number; lines: string[]; truncated: boolean }

export type SnippetResult = ({ ok: true } & SnippetText) | ({ ok: false } & SnippetFailure)

export type SnippetOptions = {
  fetch?: (src: string, init: RequestInit) => Promise<Response>
  timeout?: number
  maxBytes?: number
  maxLines?: number
}

/**
 * Fetches `src` and picks `lines` (first and last, from 1; null for all) out of
 * it. Never throws: a failure comes back as its reason.
 */
export async function fetchSnippet(
  src: string,
  lines: readonly [number, number] | null,
  options: SnippetOptions = {},
): Promise<SnippetResult> {
  const {
    fetch: get = globalThis.fetch,
    timeout = SNIPPET_TIMEOUT,
    maxBytes = SNIPPET_MAX_BYTES,
    maxLines = SNIPPET_MAX_LINES,
  } = options
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  let bytes: Uint8Array | null
  try {
    const res = await get(src, {
      // Nothing of the viewer's: no cookies, and no Referer naming the relay.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'default',
      signal: controller.signal,
    })
    if (!res.ok) {
      void res.body?.cancel().catch(() => {})
      return { ok: false, reason: 'status', status: res.status }
    }
    bytes = await readAtMost(res, maxBytes, controller.signal)
  } catch {
    return { ok: false, reason: timedOut ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
  if (bytes === null) return { ok: false, reason: 'too-large' }
  // A NUL byte is what text files do not have and binary ones nearly always do.
  if (bytes.includes(0)) return { ok: false, reason: 'binary' }
  return pick(new TextDecoder('utf-8').decode(bytes), lines, maxLines)
}

/**
 * The body, or null as soon as it grows past `max` bytes, whatever Content-Length
 * said. Throws once `signal` aborts, even if the body itself does not notice.
 */
async function readAtMost(
  res: Response,
  max: number,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (Number(res.headers.get('Content-Length')) > max) {
    void res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer())
    return all.byteLength > max ? null : all
  }
  const reader = res.body.getReader()
  // Cancelling ends a read that is waiting; the check below tells it from the end.
  const stop = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', stop)
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  signal.removeEventListener('abort', stop)
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** The lines of `text` from `lines`, at most `max` of them. */
export function pick(
  text: string,
  lines: readonly [number, number] | null,
  max: number = SNIPPET_MAX_LINES,
): SnippetResult {
  const all = text.split(/\r\n|\r|\n/)
  // A final newline ends the last line rather than starting another.
  if (all.length > 1 && all.at(-1) === '') all.pop()
  const [from, to] = lines ?? [1, all.length]
  if (from > all.length) return { ok: false, reason: 'range', total: all.length }
  const wanted = all.slice(from - 1, Math.min(to, all.length))
  return { ok: true, from, lines: wanted.slice(0, max), truncated: wanted.length > max }
}

/** A short sentence for a placeholder that could not show its snippet. */
export function failureMessage(failure: SnippetFailure, maxBytes = SNIPPET_MAX_BYTES): string {
  switch (failure.reason) {
    case 'network':
      return 'The file could not be loaded. It may not be public, or the network failed.'
    case 'status':
      return failure.status === 404
        ? 'The file was not found. Only public files can be shown.'
        : `The file could not be loaded (HTTP ${failure.status}).`
    case 'too-large':
      return `The file is larger than ${Math.round(maxBytes / 1024)} KB.`
    case 'timeout':
      return 'The file took too long to load.'
    case 'binary':
      return 'The file is not text.'
    case 'range':
      return `The file has only ${failure.total} ${failure.total === 1 ? 'line' : 'lines'}.`
  }
}
