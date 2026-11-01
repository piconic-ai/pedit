import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket as WS } from 'ws'
import { connect, PeditError, type Status } from '../src/client.ts'
import { peditRoutes } from '../src/hono.ts'
import { BIN, sleep, tmpRoot, write } from './helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
const realFetch = globalThis.fetch
const realWS = globalThis.WebSocket
const g = globalThis as Record<string, unknown>
let sockets: WS[] = []
let sessions = 0

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  globalThis.fetch = realFetch
  globalThis.WebSocket = realWS
  delete g.location
})

beforeEach(() => {
  sockets = []
  sessions = 0
})

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

/** Node's fetch and WebSocket send no Origin; a browser does. Add it, and count what the client does. */
async function start(role: 'edit' | 'read' = 'edit', text = 'hello\n') {
  const { dir, cleanup } = tmpRoot()
  const root = join(dir, 'root')
  mkdirSync(root)
  const file = write(root, 'a.md', text)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  let current = role
  const parent = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: parent })
  const routes = peditRoutes({
    upgradeWebSocket,
    root,
    origins: [origin],
    app: 'test-app',
    resolve: async (id) => (id === 'a' ? { path: file, role: current } : null),
    bin: BIN,
    idleMs: 5000,
  })
  parent.route('/edit', routes)
  const server = serve({ fetch: parent.fetch, port, hostname: '127.0.0.1' })
  injectWebSocket(server)
  cleanups.push(
    () => routes.close(),
    () =>
      new Promise<void>((r) => {
        ;(server as Server).close(() => r())
        ;(server as Server).closeAllConnections()
      }),
    cleanup,
  )
  g.location = { origin }
  globalThis.fetch = (url, init = {}) => {
    if (String(url).endsWith('/session')) sessions++
    return realFetch(url, { ...init, headers: { origin } })
  }
  globalThis.WebSocket = class extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { origin } })
      sockets.push(this)
    }
  } as unknown as typeof globalThis.WebSocket
  return { file, routes, root, setRole: (r: 'edit' | 'read') => (current = r) }
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout')
    await sleep(20)
  }
}

const live = BIN ? describe : describe.skip

live('connect', () => {
  it('syncs the file text, and typing reaches the file', async () => {
    const { file } = await start()
    const c = await connect('/edit', 'a', { name: 'T' })
    cleanups.push(() => c.destroy())
    expect(c.role).toBe('edit')
    expect(c.status.get()).toBe('connected')
    expect(c.text.toString()).toBe('hello\n')
    c.text.insert(5, ' world')
    await until(() => readFileSync(file, 'utf8') === 'hello world\n')
  })

  it('a reader sees the text and sends nothing', async () => {
    const { file } = await start('read')
    const c = await connect('/edit', 'a')
    cleanups.push(() => c.destroy())
    expect(c.role).toBe('read')
    expect(c.text.toString()).toBe('hello\n')
    c.text.insert(5, ' nope')
    await sleep(700)
    expect(readFileSync(file, 'utf8')).toBe('hello\n')
    expect(c.status.get()).toBe('connected')
  })

  // pedit serve itself never sends 4001/4003 on a stop (the routes turn a child's exit into
  // 1011), so these close the socket from the client side with the code a relay would send.
  it.each([
    [4001, 'gone'],
    [4003, 'forbidden'],
  ])('stops with a PeditError on close code %i and never reconnects', async (code, want) => {
    await start()
    const c = await connect('/edit', 'a')
    const seen: [Status, string | undefined][] = []
    c.status.subscribe((s, e) => seen.push([s, e?.code]))
    const before = sessions
    sockets[0]?.close(code)
    await until(() => c.status.get() === 'closed')
    expect(seen.at(-1)).toEqual(['closed', want])
    await sleep(1500)
    expect(sessions).toBe(before)
    expect(sockets).toHaveLength(1)
    c.destroy()
  })

  it('stops with `forbidden` when the session re-issue is refused', async () => {
    await start()
    const c = await connect('/edit', 'a')
    globalThis.fetch = async () => new Response('{}', { status: 403 })
    sockets[0]?.terminate()
    await until(() => c.status.get() === 'closed')
    await sleep(100)
    expect(sockets).toHaveLength(1)
    c.destroy()
  })

  it('stops instead of merging its old copy into a restarted pedit', async () => {
    const { file, root } = await start()
    const c = await connect('/edit', 'a')
    const seen: [Status, string | undefined][] = []
    c.status.subscribe((s, e) => seen.push([s, e?.code]))
    execFileSync('pkill', ['-TERM', '-f', root])
    await until(() => c.status.get() === 'closed', 15000)
    expect(seen.at(-1)).toEqual(['closed', 'gone'])
    expect(c.text.toString()).toBe('hello\n')
    await sleep(300)
    expect(readFileSync(file, 'utf8')).toBe('hello\n')
    c.destroy()
  })

  it('rejects connect when the first socket drops and the retry session is refused', async () => {
    await start()
    const Base = globalThis.WebSocket
    globalThis.WebSocket = class extends (Base as unknown as typeof WS) {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols)
        if (sockets.length === 1) this.on('open', () => this.terminate())
      }
    } as unknown as typeof globalThis.WebSocket
    const f = globalThis.fetch
    globalThis.fetch = (url, init) => {
      if (sessions >= 1) return Promise.resolve(new Response('{}', { status: 403 }))
      return f(url, init)
    }
    await expect(connect('/edit', 'a')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it.each([
    ['edit', 'read'],
    ['read', 'edit'],
  ] as const)('stops when the role changes from %s to %s', async (from, to) => {
    const { setRole } = await start(from)
    const c = await connect('/edit', 'a')
    setRole(to)
    sockets[0]?.terminate()
    await until(() => c.status.get() === 'closed')
    expect(sockets).toHaveLength(1)
    c.destroy()
  })

  it('reconnects with a fresh token after a transient drop', async () => {
    await start()
    const c = await connect('/edit', 'a')
    cleanups.push(() => c.destroy())
    const seen: Status[] = []
    c.status.subscribe((s) => seen.push(s))
    expect(sessions).toBe(1)
    sockets[0]?.terminate()
    await until(() => seen.includes('connected'))
    expect(seen).toEqual(['reconnecting', 'connected'])
    expect(sessions).toBe(2)
    expect(sockets).toHaveLength(2)
    expect(c.text.toString()).toBe('hello\n')
  })

  it('maps session failures to PeditError codes', async () => {
    await start()
    await expect(connect('/edit', 'nope')).rejects.toMatchObject({ code: 'not-found' })
    await expect(connect('/edit', 'nope')).rejects.toBeInstanceOf(PeditError)
    for (const [status, code] of [
      [409, 'held'],
      [503, 'busy'],
      [403, 'forbidden'],
      [500, 'unavailable'],
    ] as const) {
      globalThis.fetch = async () => new Response('{}', { status })
      await expect(connect('/edit', 'a')).rejects.toMatchObject({ code })
    }
  })

  it('destroy closes the socket', async () => {
    await start()
    const c = await connect('/edit', 'a')
    c.destroy()
    await until(() => sockets[0]?.readyState === WS.CLOSED)
    await sleep(1200)
    expect(sockets).toHaveLength(1)
    expect(sessions).toBe(1)
  })
})
