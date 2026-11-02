import { chmodSync, mkdirSync, symlinkSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { isLoopback, type PeditEvent, type PeditOptions, peditRoutes } from '../src/hono.ts'
import { ServedFiles } from '../src/index.ts'
import { BIN, isSyncStep1, printEvent, sleep, syncStep1, tmpRoot, write } from './helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

interface Fixture {
  base: string
  origin: string
  dir: string
  root: string
  events: PeditEvent[]
  routes: ReturnType<typeof peditRoutes>
  parent: Hono
  session: (id: string, init?: RequestInit) => Promise<Response>
  token: (id: string) => Promise<string>
  dial: (id: string, token: string, origin?: string | null) => Promise<WebSocket | number>
}

async function start(over: Partial<PeditOptions> = {}): Promise<Fixture> {
  const { dir, cleanup } = tmpRoot()
  const root = join(dir, 'root')
  mkdirSync(root)
  write(root, 'a.md')
  write(root, 'b.md')
  write(dir, 'root-private/x.md')
  symlinkSync(join(dir, 'root-private'), join(root, 'link'))
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const events: PeditEvent[] = []
  const parent = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: parent })
  const files: Record<string, { path: string; role: 'edit' | 'read' }> = {
    a: { path: join(root, 'a.md'), role: 'edit' },
    r: { path: join(root, 'a.md'), role: 'read' },
    b: { path: join(root, 'b.md'), role: 'edit' },
    out: { path: join(dir, 'root-private/x.md'), role: 'edit' },
    sib: { path: `${root}-private/x.md`, role: 'edit' },
    link: { path: join(root, 'link/x.md'), role: 'edit' },
    boom: { path: '', role: 'edit' },
  }
  const routes = peditRoutes({
    upgradeWebSocket,
    root,
    origins: [origin],
    app: 'test-app',
    resolve: async (id) => {
      if (id === 'boom') throw new HTTPException(401)
      return files[id] ?? null
    },
    bin: BIN,
    idleMs: 300,
    onEvent: (e) => events.push(e),
    ...over,
  })
  parent.route('/edit', routes)
  const server = serve({ fetch: parent.fetch, port, hostname: '127.0.0.1' })
  injectWebSocket(server)
  cleanups.push(
    () => routes.close(),
    () =>
      new Promise<void>((r) => {
        const http = server as Server
        http.close(() => r())
        http.closeAllConnections()
      }),
    cleanup,
  )
  const base = `${origin}/edit`
  const session = (id: string, init: RequestInit = {}) =>
    fetch(`${base}/${id}/session`, {
      method: 'POST',
      ...init,
      headers: { origin, ...(init.headers as Record<string, string>) },
    })
  const token = async (id: string) =>
    ((await (await session(id)).json()) as { token: string }).token
  const dial = (id: string, tok: string, o: string | null = origin) =>
    new Promise<WebSocket | number>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/edit/${id}/doc?token=${tok}`,
        o === null ? {} : { headers: { origin: o } },
      )
      // pedit speaks first: catch its frame before the caller can ask for it.
      firsts.set(ws, new Promise((r) => ws.once('message', (d) => r(new Uint8Array(d as Buffer)))))
      ws.once('open', () => {
        cleanups.push(() => ws.terminate())
        resolve(ws)
      })
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.once('error', () => {})
    })
  return { base, origin, dir, root, events, routes, parent, session, token, dial }
}

const firsts = new WeakMap<WebSocket, Promise<Uint8Array>>()
const firstMessage = (ws: WebSocket) => firsts.get(ws) as Promise<Uint8Array>

const live = BIN ? describe : describe.skip

live('peditRoutes with a real pedit', () => {
  it('session, then doc, then sync step 1 arrives', async () => {
    const f = await start()
    const res = await f.session('a')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; role: string }
    expect(body.role).toBe('edit')
    expect(body.token).toMatch(/^[0-9a-f]{64}$/)
    const ws = await f.dial('a', body.token)
    expect(ws).toBeInstanceOf(WebSocket)
    expect(isSyncStep1(await firstMessage(ws as WebSocket))).toBe(true)
    ;(ws as WebSocket).close()
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'started', id: 'a' }))
  })

  it('a session carries the document generation, the same for the same child', async () => {
    const f = await start()
    const one = (await (await f.session('a')).json()) as { generation: string }
    const two = (await (await f.session('a')).json()) as { generation: string }
    expect(one.generation).toMatch(/^[0-9a-f]{32}$/)
    expect(two.generation).toBe(one.generation)
  })

  it('refuses the doc with 403 when the child restarted with another generation', async () => {
    const { dir } = tmpRoot()
    // A fake pedit: a new generation per start, exits when its stdin closes (after idleMs).
    const counter = join(dir, 'count')
    const fake = write(
      dir,
      'pedit',
      `#!/bin/sh
[ "$1" = --version ] && { echo 1.2.3; exit 0; }
n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'
${printEvent({ event: 'listening', generation: 'g#' }, 'n')}
read _
`,
    )
    chmodSync(fake, 0o755)
    const f = await start({ bin: fake, idleMs: 100 })
    const res = await f.session('a')
    const body = (await res.json()) as { token: string; generation: string }
    expect(body.generation).toBe('g1')
    await vi.waitFor(() => expect(f.events.some((e) => e.type === 'stopped')).toBe(true))
    expect(await f.dial('a', body.token)).toBe(403)
  })

  it('a reader gets step 2 for its step 1 and is closed with 4003 on an update', async () => {
    const f = await start()
    const ws = (await f.dial('r', await f.token('r'))) as WebSocket
    const closing = new Promise<number>((r) => ws.once('close', (code) => r(code)))
    const reply = firstMessage(ws)
    ws.send(syncStep1)
    expect((await reply)[1]).toBe(1)
    ws.send(new Uint8Array([0, 2, 2, 0, 0]))
    expect(await closing).toBe(4003)
  })

  it('a file held by another app is 409 for an editor and 503 for a reader', async () => {
    const f = await start()
    const other = new ServedFiles({ bin: BIN as string, app: 'other-app' })
    cleanups.push(() => other.close())
    await other.acquire(join(f.root, 'a.md'))
    const edit = await f.session('a')
    expect(edit.status).toBe(409)
    const read = await f.session('r')
    expect(read.status).toBe(503)
    for (const res of [edit, read]) {
      const text = JSON.stringify(await res.json())
      expect(text).not.toContain('other-app')
      expect(text).not.toContain(f.dir)
      expect(text).not.toMatch(/\d{3,}/)
    }
  })

  it('a token for one id does not open another', async () => {
    const f = await start()
    const tok = await f.token('a')
    expect(await f.dial('b', tok)).toBe(403)
  })

  it('the same token raced by two upgrades opens exactly one', async () => {
    const f = await start()
    const tok = await f.token('a')
    const results = await Promise.all([f.dial('a', tok), f.dial('a', tok)])
    expect(results.filter((r) => r instanceof WebSocket)).toHaveLength(1)
    expect(results.filter((r) => r === 403)).toHaveLength(1)
    for (const r of results) if (r instanceof WebSocket) r.close()
  })

  it('a token expires after 60 seconds, and a reused one is refused', async () => {
    const f = await start()
    const old = await f.token('a')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
    expect(await f.dial('a', old)).toBe(403)
    vi.useRealTimers()
    const used = await f.token('a')
    const ws = (await f.dial('a', used)) as WebSocket
    expect(ws).toBeInstanceOf(WebSocket)
    ws.close()
    await sleep(50)
    expect(await f.dial('a', used)).toBe(403)
  })

  it('a doc request needs the token, a known one, and an allowed Origin', async () => {
    const f = await start()
    expect(await f.dial('a', '')).toBe(403)
    expect(await f.dial('a', 'f'.repeat(64))).toBe(403)
    expect(await f.dial('a', await f.token('a'), 'http://evil.test')).toBe(403)
    expect(await f.dial('a', await f.token('a'), null)).toBe(403)
  })

  it('answers 429 after 10 sessions in a second', async () => {
    const f = await start()
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) statuses.push((await f.session('a')).status)
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(10)).toEqual([429, 429])
  })
})

describe('peditRoutes checks', () => {
  it('404s for a bad id, an unknown id, and paths outside root', async () => {
    const f = await start()
    for (const id of ['nope', 'bad.id', 'a%20b', 'x'.repeat(129), 'out', 'sib', 'link']) {
      const res = await f.session(id)
      expect(res.status, id).toBe(404)
    }
    expect(f.events.filter((e) => e.type === 'started')).toEqual([])
  })

  it('refuses a Host that is not one of the origins', async () => {
    const f = await start()
    const url = new URL(`${f.base}/a/session`)
    const status = await new Promise<number>((resolve) => {
      const req = httpRequest(
        url,
        { method: 'POST', headers: { host: 'evil.test', origin: f.origin } },
        (res) => resolve(res.statusCode ?? 0),
      )
      req.end()
    })
    expect(status).toBe(404)
  })

  it('refuses an Origin that is not allowed, and accepts Sec-Fetch-Site: same-origin', async () => {
    const f = await start()
    const bad = await f.session('a', { headers: { origin: 'http://evil.test' } })
    expect(bad.status).toBe(403)
    const none = await fetch(`${f.base}/a/session`, { method: 'POST' })
    expect(none.status).toBe(403)
    // Without an Origin header, same-origin Fetch Metadata is enough. 404 shows it got past the check.
    const same = await fetch(`${f.base}/nope/session`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin' },
    })
    expect(same.status).toBe(404)
  })

  it('passes an HTTPException from resolve and hides other errors', async () => {
    const f = await start()
    expect((await f.session('boom')).status).toBe(401)
    const g = await start({
      resolve: async () => {
        throw new Error(`secret ${process.cwd()}`)
      },
    })
    const res = await g.session('a')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('secret')
  })

  it('refuses a non-loopback peer unless allowRemote', async () => {
    const f = await start()
    const remote = { incoming: { socket: { remoteAddress: '10.1.2.3' } } }
    const init = { method: 'POST', headers: { origin: f.origin, host: new URL(f.origin).host } }
    expect((await f.parent.request('/edit/a/session', init, remote)).status).toBe(403)
    expect((await f.parent.request('/edit/a/session', init, {})).status).toBe(403)
    const g = await start({ allowRemote: true })
    const init2 = { method: 'POST', headers: { origin: g.origin, host: new URL(g.origin).host } }
    expect((await g.parent.request('/edit/nope/session', init2, remote)).status).toBe(404)
  })

  it('knows loopback addresses', () => {
    for (const a of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopback(a), a).toBe(true)
    }
    for (const a of ['10.0.0.1', '::ffff:10.0.0.1', '::2', '1127.0.0.1', '', undefined]) {
      expect(isLoopback(a), String(a)).toBe(false)
    }
  })

  it('validates its options at construction', async () => {
    const f = await start()
    const base = {
      upgradeWebSocket: (() => () => {}) as never,
      root: f.root,
      origins: [f.origin],
      app: 'x',
      resolve: async () => null,
    }
    expect(() => peditRoutes(base)).not.toThrow()
    expect(() => peditRoutes({ ...base, root: join(f.root, 'missing') })).toThrow()
    expect(() => peditRoutes({ ...base, root: join(f.root, 'a.md') })).toThrow()
    expect(() => peditRoutes({ ...base, app: '' })).toThrow()
    expect(() => peditRoutes({ ...base, origins: [] })).toThrow()
    for (const o of ['*', 'localhost', 'http://a.test/', 'http://a.test/x', 'ftp://a.test']) {
      expect(() => peditRoutes({ ...base, origins: [o] }), o).toThrow()
    }
  })

  it('a missing pedit binary is 503 busy, not a crash', async () => {
    const f = await start({ bin: join(tmpdirOf(), 'no-such-pedit') })
    const res = await f.session('a')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'busy' })
    expect(f.events.some((e) => e.type === 'error')).toBe(true)
  })
})

function tmpdirOf(): string {
  return tmpRoot().dir
}
