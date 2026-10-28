import { describe, expect, it, vi } from 'vitest'
import {
  BodyReadTimeoutError,
  BodyTooLargeError,
  InvalidBodyLengthError,
  readBoundedBody,
} from '../src/bounded-body.ts'

function input(chunks: Uint8Array[], length?: string) {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  const headers = new Headers()
  if (length !== undefined) headers.set('Content-Length', length)
  return {
    request: new Request('https://pedit.test/', { method: 'POST', body: stream, headers }),
    cancelled: () => cancelled,
  }
}
const chunk = (...n: number[]) => Uint8Array.from(n)

describe('bounded request body', () => {
  it('times out and releases a stalled body even when cancellation never resolves', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
        return new Promise<void>(() => {})
      },
    })
    const request = new Request('https://pedit.test/', { method: 'POST', body })
    await expect(readBoundedBody(request, 3, 20)).rejects.toBeInstanceOf(BodyReadTimeoutError)
    expect(cancelled).toBe(true)
    expect(request.body?.locked).toBe(false)
  })
  it('accepts exactly the limit without a declared length', async () => {
    const { request } = input([chunk(1, 2), chunk(3)])
    expect([...new Uint8Array(await readBoundedBody(request, 3))]).toEqual([1, 2, 3])
  })

  it('rejects an oversized declared or streamed body', async () => {
    const declared = input([chunk(1, 2, 3, 4)], '4')
    await expect(readBoundedBody(declared.request, 3)).rejects.toBeInstanceOf(BodyTooLargeError)
    const streamed = input([
      chunk(1, 2),
      chunk(3, 4),
      ...Array.from({ length: 10 }, () => chunk(5)),
    ])
    await expect(readBoundedBody(streamed.request, 3)).rejects.toBeInstanceOf(BodyTooLargeError)
    await vi.waitFor(() => expect(streamed.cancelled()).toBe(true))
  })

  it('rejects invalid or dishonest lengths', async () => {
    for (const header of ['-1', '1.5', '1e2', '01', '9007199254740992']) {
      await expect(readBoundedBody(input([], header).request, 3)).rejects.toBeInstanceOf(
        InvalidBodyLengthError,
      )
    }
    await expect(readBoundedBody(input([chunk(1, 2)], '3').request, 3)).rejects.toBeInstanceOf(
      InvalidBodyLengthError,
    )
    const tooLong = input([chunk(1), chunk(2), ...Array.from({ length: 10 }, () => chunk(3))], '1')
    await expect(readBoundedBody(tooLong.request, 3)).rejects.toBeInstanceOf(InvalidBodyLengthError)
    await vi.waitFor(() => expect(tooLong.cancelled()).toBe(true))
  })

  it('leaves the body unlocked if allocating the output fails', async () => {
    const { request } = input([chunk(1)])
    await expect(readBoundedBody(request, Number.MAX_SAFE_INTEGER)).rejects.toThrow()
    expect(request.body?.locked).toBe(false)
    expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([1])
  })

  it('cancels the body after rejecting an oversized declared length', async () => {
    const declared = input(
      Array.from({ length: 20 }, () => chunk(1)),
      '4',
    )
    await expect(readBoundedBody(declared.request, 3)).rejects.toBeInstanceOf(BodyTooLargeError)
    await vi.waitFor(() => expect(declared.cancelled()).toBe(true))
  })

  it('rejects invalid headers without waiting for stream cancellation', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
        return new Promise<void>(() => {})
      },
    })
    const request = new Request('https://pedit.test/', {
      method: 'POST',
      body,
      headers: { 'Content-Length': 'invalid' },
    })
    await expect(readBoundedBody(request, 3)).rejects.toBeInstanceOf(InvalidBodyLengthError)
    await vi.waitFor(() => expect(cancelled).toBe(true))
  }, 1000)

  it('handles absent and empty bodies', async () => {
    expect((await readBoundedBody(new Request('https://pedit.test/'), 0)).byteLength).toBe(0)
    expect((await readBoundedBody(input([], '0').request, 0)).byteLength).toBe(0)
    await expect(
      readBoundedBody(
        new Request('https://pedit.test/', { headers: { 'Content-Length': '1' } }),
        1,
      ),
    ).rejects.toBeInstanceOf(InvalidBodyLengthError)
  })
})
