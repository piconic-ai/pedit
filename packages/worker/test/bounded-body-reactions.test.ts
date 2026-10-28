import { expect, it, vi } from 'vitest'
import {
  BodyChunkLimitError,
  BodyReadTimeoutError,
  MAX_BODY_CHUNKS,
  readBoundedBody,
} from '../src/bounded-body.ts'

it('does not register timeout reactions per tiny chunk', async () => {
  let n = 0
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (n++ < 10000) c.enqueue(Uint8Array.of(1))
      else c.close()
    },
  })
  const req = new Request('https://pedit.test/', { method: 'POST', body })
  const spy = vi.spyOn(Promise, 'race')
  try {
    expect((await readBoundedBody(req, 10000)).byteLength).toBe(10000)
    expect(spy.mock.calls.length).toBeLessThan(5)
  } finally {
    spy.mockRestore()
  }
})

it('bounds immediate empty chunks even when the clock does not advance', async () => {
  let count = 0
  let cancelled = false
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100)
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      count++
      controller.enqueue(new Uint8Array())
    },
    cancel() {
      cancelled = true
    },
  })
  const request = new Request('https://pedit.test/', { method: 'POST', body })
  try {
    await expect(readBoundedBody(request, 1, 30_000)).rejects.toBeInstanceOf(BodyChunkLimitError)
    expect(count).toBeLessThanOrEqual(MAX_BODY_CHUNKS + 2)
    expect(cancelled).toBe(true)
    expect(request.body?.locked).toBe(false)
  } finally {
    clock.mockRestore()
  }
})

it('accepts a body at the chunk limit', async () => {
  let count = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (count++ < MAX_BODY_CHUNKS) controller.enqueue(Uint8Array.of(1))
      else controller.close()
    },
  })
  const request = new Request('https://pedit.test/', { method: 'POST', body })
  expect((await readBoundedBody(request, MAX_BODY_CHUNKS)).byteLength).toBe(MAX_BODY_CHUNKS)
})

it('checks an expired deadline even when reads never yield to a timer', async () => {
  let now = 100
  let reads = 0
  let cancelled = false
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++reads > 1) now = 102
      controller.enqueue(Uint8Array.of(1))
    },
    cancel() {
      cancelled = true
    },
  })
  const request = new Request('https://pedit.test/', { method: 'POST', body })
  try {
    await expect(readBoundedBody(request, 10, 1)).rejects.toBeInstanceOf(BodyReadTimeoutError)
    expect(cancelled).toBe(true)
    expect(request.body?.locked).toBe(false)
  } finally {
    clock.mockRestore()
  }
})

it('times out after a partial body and releases the reader even if cancel stalls', async () => {
  let delivered = false
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!delivered) {
        delivered = true
        controller.enqueue(Uint8Array.of(1))
      }
    },
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
