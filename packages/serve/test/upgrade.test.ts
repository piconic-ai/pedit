import { join } from 'node:path'
import type { WSEvents } from 'hono/ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { peditRoutes } from '../src/hono.ts'
import { BIN, tmpRoot, write } from './helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

describe.skipIf(!BIN)('a slow browser upgrade', () => {
  it('closes the browser when pedit went away before onOpen', async () => {
    const { dir, cleanup } = tmpRoot()
    cleanups.push(cleanup)
    write(dir, 'a.md')
    let events: WSEvents | undefined
    const origin = 'http://app.test'
    const routes = peditRoutes({
      // The adapter would call onOpen after its own handshake; here the test decides when.
      upgradeWebSocket: ((create: () => WSEvents) => async () => {
        events = create()
        return new Response(null, { status: 200 })
      }) as never,
      root: dir,
      origins: [origin],
      app: 'test-app',
      bin: BIN,
      resolve: async () => ({ path: join(dir, 'a.md'), role: 'edit' }),
    })
    cleanups.push(() => routes.close())
    const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
    const headers = { host: 'app.test', origin }
    const session = await routes.request('/x/session', { method: 'POST', headers }, env)
    const { token } = (await session.json()) as { token: string }
    const doc = await routes.request(
      `/x/doc?token=${token}`,
      { headers: { ...headers, upgrade: 'websocket' } },
      env,
    )
    expect(doc.status).toBe(200)

    await routes.close() // pedit ends and its socket closes while the browser is still upgrading
    const ws = { close: vi.fn(), send: vi.fn(), raw: {} }
    events?.onOpen?.(new Event('open'), ws as never)
    expect(ws.close).toHaveBeenCalledTimes(1)
    expect(ws.send).not.toHaveBeenCalled()
  })
})
