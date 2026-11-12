import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve, upgradeWebSocket } from '@hono/node-server'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocketServer, WebSocket as WS } from 'ws'
import { connect, PeditError, type Status } from '../src/client.ts'
import { peditRoutes } from '../src/hono.ts'
import { BIN, sleep, tmpRoot, write } from './helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
const realFetch = globalThis.fetch
const realWS = globalThis.WebSocket
const g = globalThis as Record<string, unknown>
let sockets: WS[] = []
let sessions = 0
let generations: string[] = []

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  globalThis.fetch = realFetch
  globalThis.WebSocket = realWS
  delete g.location
})

beforeEach(() => {
  sockets = []
  sessions = 0
  generations = []
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
  // pedit keeps its recovery state under the user's config directory: give it one of our own.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'pedit-serve-home-')))
  const saved = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    APPDATA: process.env.APPDATA,
  }
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = join(home, '.config')
  process.env.APPDATA = join(home, 'AppData') // Go's os.UserConfigDir on Windows
  const root = join(dir, 'root')
  mkdirSync(root)
  const file = write(root, 'a.md', text)
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  let current = role
  const parent = new Hono()
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
  const server = serve({
    fetch: parent.fetch,
    port,
    hostname: '127.0.0.1',
    websocket: { server: new WebSocketServer({ noServer: true }) },
  })
  // Cleanups run last to first: pedit must be stopped before its directories are removed (Windows
  // refuses to remove a directory a running child holds).
  cleanups.push(
    cleanup,
    () => rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
    () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    },
    () =>
      new Promise<void>((r) => {
        ;(server as Server).close(() => r())
        ;(server as Server).closeAllConnections()
      }),
    () => routes.close(),
  )
  g.location = { origin }
  globalThis.fetch = (url, init = {}) => {
    const res = realFetch(url, { ...init, headers: { origin } })
    if (!String(url).endsWith('/session')) return res
    sessions++
    return res.then(async (r) => {
      if (r.ok) generations.push(((await r.clone().json()) as { generation: string }).generation)
      return r
    })
  }
  globalThis.WebSocket = class extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols, { headers: { origin } })
      sockets.push(this)
    }
  } as unknown as typeof globalThis.WebSocket
  /** Forget every recovery state, as if they had aged out. */
  const discardState = () => {
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory() && e.name === 'state' && d.endsWith(join('pedit', 'serve')))
          rmSync(p, { recursive: true })
        else if (e.isDirectory()) walk(p)
      }
    }
    walk(home)
  }
  return { file, routes, root, discardState, setRole: (r: 'edit' | 'read') => (current = r) }
}

function execFileSyncOk(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
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

  it('stops with `forbidden` on close code 4003 and never reconnects', async () => {
    await start()
    const c = await connect('/edit', 'a')
    const seen: [Status, string | undefined][] = []
    c.status.subscribe((s, e) => seen.push([s, e?.code]))
    const before = sessions
    sockets[0]?.close(4003)
    await until(() => c.status.get() === 'closed')
    expect(seen.at(-1)).toEqual(['closed', 'forbidden'])
    await sleep(1500)
    expect(sessions).toBe(before)
    expect(sockets).toHaveLength(1)
    c.destroy()
  })

  it('on close code 4001 re-issues a session and reconnects when the generation is the same', async () => {
    await start()
    const c = await connect('/edit', 'a')
    cleanups.push(() => c.destroy())
    sockets[0]?.close(4001)
    await until(() => sessions === 2 && c.status.get() === 'connected')
    expect(generations).toHaveLength(2)
    expect(generations[1]).toBe(generations[0])
    expect(c.text.toString()).toBe('hello\n')
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

  // The two restart tests signal the child (pkill), which Windows cannot do without killing it.
  const unix = process.platform === 'win32' ? it.skip : it

  unix(
    'reconnects to a restarted pedit that kept its state, without duplicating the text',
    async () => {
      const { file, root } = await start()
      const c = await connect('/edit', 'a')
      cleanups.push(() => c.destroy())
      const before = sessions
      execFileSync('pkill', ['-TERM', '-f', root])
      await until(() => sessions > before && c.status.get() === 'connected', 15000)
      expect(generations.at(-1)).toBe(generations[0])
      expect(c.text.toString()).toBe('hello\n')
      await sleep(300)
      expect(c.text.toString()).toBe('hello\n')
      expect(readFileSync(file, 'utf8')).toBe('hello\n')
    },
  )

  unix(
    'stops with `gone` when the restarted pedit lost its state, and keeps the page text',
    async () => {
      const { root, discardState } = await start()
      const c = await connect('/edit', 'a')
      cleanups.push(() => c.destroy())
      c.text.insert(5, ' typed')
      const before = sessions
      // The child saves on SIGTERM, so remove the state once it has exited.
      execFileSync('pkill', ['-TERM', '-f', root])
      await sleep(300)
      await until(() => execFileSyncOk('pgrep', ['-f', root]) === false)
      discardState()
      const err = await new Promise<PeditError | undefined>((resolve) =>
        c.status.subscribe((s, e) => s === 'closed' && resolve(e)),
      )
      expect(err).toMatchObject({ code: 'gone' })
      expect(generations).toHaveLength(sessions)
      expect(sessions).toBeGreaterThan(before)
      expect(generations.at(-1)).not.toBe(generations[0])
      expect(sockets).toHaveLength(1)
      expect(c.text.toString()).toBe('hello typed\n')
    },
  )

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
