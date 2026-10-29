import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it, vi } from 'vitest'
import { signingPair } from '../../protocol/src/access-crypto.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../protocol/src/kept-access.ts'
import { createKeptSenderCertificate, sealKeptRecord } from '../../protocol/src/kept-record.ts'
import { KeptRoomClient } from '../../protocol/src/kept-room-client.ts'
import fixture from '../../testdata/kept-read-interop.json'
import shared from '../../testdata/kept-recovery-wire.json'
import app from '../src/index.ts'

it('recovers consecutive maximum-tail reads through the public page limiter', async () => {
  const keys = await deriveKeptRoomKeys(parseKeptFragment(fixture.fragment)!, fixture.roomId)
  const pair = await signingPair(new Uint8Array(32).fill(11))
  const certificate = await createKeptSenderCertificate(keys, pair.publicKey)
  const record = await sealKeptRecord(
    keys,
    {
      roomId: fixture.roomId,
      epoch: Uint8Array.from(fixture.epoch.match(/../g)!, (x) => Number.parseInt(x, 16)),
      generation: 1,
    },
    pair.sign,
    certificate,
    1,
    Uint8Array.from(atob(shared.textMessage.replace(/-/g, '+').replace(/_/g, '/')), (x) =>
      x.charCodeAt(0),
    ),
  )
  const ciphertext = btoa(String.fromCharCode(...record))
  const cursor = (page: number) => `00000000-0000-4000-8000-${page.toString().padStart(12, '0')}`
  let pages = 0,
    refused = 0,
    windowPages = 0
  let windowStart = Date.now()
  let limited!: () => void
  const throttled = new Promise<void>((resolve) => {
    limited = resolve
  })
  const allow = { limit: async () => ({ success: true }) } as unknown as RateLimit
  const bindings = {
    ...env,
    KEEP_PUBLIC_V6: '1',
    CONNECTION_LIMIT: allow,
    ROOM_CREATION_LIMIT: allow,
    KEPT_APPEND_LIMIT: allow,
    KEPT_PAGE_LIMIT: {
      limit: async () => {
        if (Date.now() - windowStart >= 60_000) {
          windowStart = Date.now()
          windowPages = 0
        }
        const success = ++windowPages <= 120
        if (!success) {
          refused++
          limited()
        }
        return { success }
      },
    } as unknown as RateLimit,
    ROOM: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (request: Request) => {
          if (request.method === 'POST')
            return Response.json({
              epoch: fixture.epoch,
              generation: 1,
              cutoff: 0,
              ciphertext: fixture.checkpoint,
              tail: 1024,
              session: cursor(100),
              cursor: cursor(0),
            })
          if (request.method === 'DELETE') return new Response(null, { status: 204 })
          pages++
          const page = Number(request.headers.get('X-Pedit-Read-Cursor')!.slice(-12))
          return Response.json({
            entries: Array.from({ length: 16 }, (_, index) => ({
              sequence: page * 16 + index + 1,
              ciphertext,
            })),
            next: page === 63 ? null : cursor(page + 1),
          })
        },
      }),
    } as unknown as Env['ROOM'],
  }
  const client = new KeptRoomClient({
    url: 'https://relay.example',
    keys,
    attachmentInventory: async () => 'none',
    fetch: async (input, init) =>
      app.fetch(new Request(input, init), bindings, createExecutionContext()),
  })
  vi.useFakeTimers()
  try {
    expect((await client.inspect()).records).toBe(1024)
    expect(pages).toBe(64)
    const second = client.inspect()
    await throttled
    await vi.advanceTimersByTimeAsync(0)
    expect(pages).toBe(120)
    expect(refused).toBe(1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(pages).toBe(120)
    await vi.advanceTimersByTimeAsync(1)
    expect((await second).records).toBe(1024)
    expect(pages).toBe(128)
    expect(refused).toBe(1)
  } finally {
    vi.useRealTimers()
  }
}, 30000)
