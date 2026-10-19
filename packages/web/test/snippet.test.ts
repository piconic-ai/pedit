import { describe, expect, it, vi } from 'vitest'
import {
  failureMessage,
  fetchSnippet,
  pick,
  SNIPPET_MAX_BYTES,
  SNIPPET_MAX_LINES,
  SNIPPET_TIMEOUT,
} from '../src/snippet.ts'

const SRC = 'https://raw.githubusercontent.com/o/r/main/a.ts'
const encode = (text: string) => new TextEncoder().encode(text)

/** A fetch that answers `body` and records what it was asked. */
function answering(body: BodyInit | null, init?: ResponseInit) {
  return vi.fn((_src: string, _init?: RequestInit) => Promise.resolve(new Response(body, init)))
}

/** A body that hands out `chunk` until it is cancelled, counting what it gave. */
function endless(chunk: Uint8Array) {
  const stream = {
    pulled: 0,
    cancelled: false,
    body: null as unknown as ReadableStream<Uint8Array>,
  }
  stream.body = new ReadableStream<Uint8Array>({
    pull(controller) {
      stream.pulled++
      controller.enqueue(chunk)
    },
    cancel() {
      stream.cancelled = true
    },
  })
  return stream
}

/** A fetch that answers only once its signal aborts, by failing as fetch does. */
function hanging() {
  return vi.fn(
    (_src: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')))
      }),
  )
}

describe('fetchSnippet', () => {
  it('asks without cookies or referrer, under a time limit', async () => {
    const fetch = answering('a\n')
    await fetchSnippet(SRC, null, { fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [src, init] = fetch.mock.calls[0] ?? []
    expect(src).toBe(SRC)
    expect(init).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'default',
    })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    // Nothing else: no headers, method or body of the editor's.
    expect(Object.keys(init ?? {}).sort()).toEqual([
      'cache',
      'credentials',
      'referrerPolicy',
      'signal',
    ])
  })

  it('has the limits the issue asks for', () => {
    expect(SNIPPET_TIMEOUT).toBe(10_000)
    expect(SNIPPET_MAX_BYTES).toBe(1024 * 1024)
    expect(SNIPPET_MAX_LINES).toBe(5000)
  })

  it('shows the whole file, or the lines asked for, numbered from the first', async () => {
    const fetch = answering('one\ntwo\nthree\nfour\n')
    expect(await fetchSnippet(SRC, null, { fetch })).toEqual({
      ok: true,
      from: 1,
      lines: ['one', 'two', 'three', 'four'],
      truncated: false,
    })
    expect(
      await fetchSnippet(SRC, [2, 3], { fetch: answering('one\ntwo\nthree\nfour\n') }),
    ).toEqual({ ok: true, from: 2, lines: ['two', 'three'], truncated: false })
  })

  it('decodes UTF-8 split across chunks', async () => {
    const bytes = encode('文書\n')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2))
        controller.enqueue(bytes.slice(2))
        controller.close()
      },
    })
    expect(await fetchSnippet(SRC, null, { fetch: answering(body) })).toMatchObject({
      ok: true,
      lines: ['文書'],
    })
  })

  it.each([404, 403, 500])('says so for HTTP %i', async (status) => {
    expect(await fetchSnippet(SRC, null, { fetch: answering('nope', { status }) })).toEqual({
      ok: false,
      reason: 'status',
      status,
    })
  })

  it('says the network failed when fetch does, as for CORS', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    expect(await fetchSnippet(SRC, null, { fetch })).toEqual({ ok: false, reason: 'network' })
  })

  it('gives up on a file larger than the limit while it arrives', async () => {
    const stream = endless(new Uint8Array(1000).fill(97))
    const result = await fetchSnippet(SRC, null, {
      fetch: answering(stream.body),
      maxBytes: 10_000,
    })
    expect(result).toEqual({ ok: false, reason: 'too-large' })
    // It stopped reading soon after the limit, rather than at the end.
    expect(stream.pulled).toBeLessThanOrEqual(12)
    expect(stream.cancelled).toBe(true)
  })

  it('gives up on a Content-Length over the limit before reading', async () => {
    const stream = endless(new Uint8Array(10))
    const fetch = answering(stream.body, { headers: { 'Content-Length': '2000000' } })
    expect(await fetchSnippet(SRC, null, { fetch })).toEqual({ ok: false, reason: 'too-large' })
    expect(stream.cancelled).toBe(true)
  })

  it('does not trust a small Content-Length', async () => {
    const stream = endless(new Uint8Array(1000))
    const fetch = answering(stream.body, { headers: { 'Content-Length': '10' } })
    expect(await fetchSnippet(SRC, null, { fetch, maxBytes: 5000 })).toEqual({
      ok: false,
      reason: 'too-large',
    })
  })

  it('takes a file of exactly the limit', async () => {
    const fetch = answering('a'.repeat(100))
    expect(await fetchSnippet(SRC, null, { fetch, maxBytes: 100 })).toMatchObject({ ok: true })
  })

  it('gives up when the answer takes too long', async () => {
    const fetch = hanging()
    expect(await fetchSnippet(SRC, null, { fetch, timeout: 5 })).toEqual({
      ok: false,
      reason: 'timeout',
    })
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('gives up when the body takes too long, even one that ignores the abort', async () => {
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })
    expect(await fetchSnippet(SRC, null, { fetch: answering(body), timeout: 5 })).toEqual({
      ok: false,
      reason: 'timeout',
    })
  })

  it('refuses what does not look like text', async () => {
    const fetch = answering(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]))
    expect(await fetchSnippet(SRC, null, { fetch })).toEqual({ ok: false, reason: 'binary' })
  })

  it('says how many lines a file has when the ones asked for are past its end', async () => {
    expect(await fetchSnippet(SRC, [5, 9], { fetch: answering('a\nb\n') })).toEqual({
      ok: false,
      reason: 'range',
      total: 2,
    })
  })
})

describe('pick', () => {
  it('splits on any line ending, and a final newline ends the last line', () => {
    expect(pick('a\r\nb\rc\nd', null)).toMatchObject({ lines: ['a', 'b', 'c', 'd'] })
    expect(pick('a\n\n', null)).toMatchObject({ lines: ['a', ''] })
    expect(pick('', null)).toMatchObject({ ok: true, from: 1, lines: [''] })
  })

  it('stops at the end of the file', () => {
    expect(pick('a\nb\nc\n', [2, 1_000_000])).toEqual({
      ok: true,
      from: 2,
      lines: ['b', 'c'],
      truncated: false,
    })
  })

  it('shows at most so many lines, and says it left some out', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    expect(pick(text, [3, 30], 5)).toEqual({
      ok: true,
      from: 3,
      lines: ['line 3', 'line 4', 'line 5', 'line 6', 'line 7'],
      truncated: true,
    })
    expect(pick(text, [3, 7], 5)).toMatchObject({ truncated: false })
  })
})

describe('failureMessage', () => {
  it('says briefly what went wrong', () => {
    expect(failureMessage({ reason: 'status', status: 404 })).toMatch(/not found.*public/)
    expect(failureMessage({ reason: 'status', status: 500 })).toContain('HTTP 500')
    expect(failureMessage({ reason: 'too-large' })).toBe('The file is larger than 1024 KB.')
    expect(failureMessage({ reason: 'timeout' })).toMatch(/too long/)
    expect(failureMessage({ reason: 'binary' })).toMatch(/not text/)
    expect(failureMessage({ reason: 'network' })).toMatch(/public/)
    expect(failureMessage({ reason: 'range', total: 1 })).toBe('The file has only 1 line.')
    expect(failureMessage({ reason: 'range', total: 3 })).toBe('The file has only 3 lines.')
  })
})
