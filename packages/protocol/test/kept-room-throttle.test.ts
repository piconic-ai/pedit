import { afterEach, expect, it, vi } from 'vitest'
import fixture from '../../testdata/kept-read-interop.json'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { KeptRoomClient } from '../src/kept-room-client.ts'

async function setup(retryAfter: string | null = '1', refusals = Infinity, throttlePost = false) {
  const keys = await deriveKeptRoomKeys(parseKeptFragment(fixture.fragment)!, fixture.roomId)
  let pages = 0
  let posts = 0
  let started!: () => void
  const firstPage = new Promise<void>((resolve) => {
    started = resolve
  })
  const client = new KeptRoomClient({
    url: 'https://relay.example',
    keys,
    attachmentInventory: async () => 'none',
    fetch: async (_input, init) => {
      if (init?.method === 'POST' && ++posts === 1 && throttlePost) {
        started()
        return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
      }
      if (init?.method === 'POST')
        return Response.json({
          epoch: fixture.epoch,
          generation: 1,
          cutoff: 0,
          ciphertext: fixture.checkpoint,
          tail: 0,
          session: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          cursor: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        })
      if (init?.method === 'DELETE') return new Response(null, { status: 204 })
      pages++
      started()
      if (pages > refusals) return Response.json({ entries: [], next: null })
      return new Response(null, {
        status: 429,
        headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
      })
    },
  })
  return { client, pages: () => pages, posts: () => posts, firstPage }
}
afterEach(() => vi.useRealTimers())
it('waits for Retry-After and stops after two throttling retries', async () => {
  const { client, pages, firstPage } = await setup()
  vi.useFakeTimers()
  const read = client.inspect()
  const rejected = expect(read).rejects.toThrow('kept read rate limited')
  await firstPage
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(999)
  expect(pages()).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(pages()).toBe(2)
  await vi.advanceTimersByTimeAsync(1000)
  await rejected
  expect(pages()).toBe(3)
})
it('aborts throttling backoff without another page request', async () => {
  const { client, pages, firstPage } = await setup('60')
  vi.useFakeTimers()
  const controller = new AbortController()
  const read = client.inspect(controller.signal)
  const rejected = expect(read).rejects.toThrow()
  await firstPage
  await vi.advanceTimersByTimeAsync(0)
  controller.abort()
  await rejected
  expect(pages()).toBe(1)
})
it.each(['0', '61', '-1', '1.5', '1e0', 'tomorrow'])(
  'refuses invalid Retry-After %s without retrying',
  async (delay) => {
    const { client, pages } = await setup(delay)
    await expect(client.inspect()).rejects.toThrow('kept read rate limited')
    expect(pages()).toBe(1)
  },
)

it('resumes the fixed read after throttling clears', async () => {
  const { client, pages, firstPage } = await setup('1', 1)
  vi.useFakeTimers()
  const read = client.inspect()
  await firstPage
  await vi.advanceTimersByTimeAsync(1000)
  expect((await read).records).toBe(0)
  expect(pages()).toBe(2)
})
it('defaults missing Retry-After to one minute', async () => {
  const { client, pages, firstPage } = await setup(null, 1)
  vi.useFakeTimers()
  const read = client.inspect()
  await firstPage
  await vi.advanceTimersByTimeAsync(59_999)
  expect(pages()).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect((await read).records).toBe(0)
  expect(pages()).toBe(2)
})

it('backs off when the public control limiter refuses initial snapshot creation', async () => {
  const { client, pages, posts, firstPage } = await setup('1', 0, true)
  vi.useFakeTimers()
  const read = client.inspect()
  await firstPage
  await vi.advanceTimersByTimeAsync(999)
  expect(posts()).toBe(1)
  expect(pages()).toBe(0)
  await vi.advanceTimersByTimeAsync(1)
  expect((await read).records).toBe(0)
  expect(posts()).toBe(2)
  expect(pages()).toBe(1)
})
