import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import { createServer } from 'node:net'
import { join, sep } from 'node:path'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { inside, isLoopback, type PeditEvent, type PeditOptions, peditRoutes } from '../src/hono.ts'
import { ServedFiles } from '../src/index.ts'
import {
  BIN,
  FAKE,
  fakePedit,
  isSyncStep1,
  printEvent,
  sleep,
  syncStep1,
  tmpRoot,
  write,
} from './helpers.ts'

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
  symlinkSync(join(dir, 'root-private'), join(root, 'link'), 'junction')
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
  // Cleanups run last to first: pedit must be stopped before its directory is removed (Windows
  // refuses to remove a directory a running child holds).
  cleanups.push(
    cleanup,
    () =>
      new Promise<void>((r) => {
        const http = server as Server
        http.close(() => r())
        http.closeAllConnections()
      }),
    () => routes.close(),
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

  it.skipIf(!FAKE)(
    'refuses the doc with 403 when the child restarted with another generation',
    async () => {
      const { dir } = tmpRoot()
      // A fake pedit: a new generation per start, exits when its stdin closes (after idleMs).
      const counter = join(dir, 'count')
      const fake = fakePedit(
        dir,
        'pedit',
        `const fs = require('node:fs')
if (process.argv[2] === '--version') { console.log('1.2.3'); process.exit(0) }
let n = 0
try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) } catch {}
n++
fs.writeFileSync(${JSON.stringify(counter)}, String(n))
${printEvent({ event: 'listening', generation: 'g#' }, 'n')}
process.stdin.resume()
`,
      )
      const f = await start({ bin: fake, idleMs: 100 })
      const res = await f.session('a')
      const body = (await res.json()) as { token: string; generation: string }
      expect(body.generation).toBe('g1')
      await vi.waitFor(() => expect(f.events.some((e) => e.type === 'stopped')).toBe(true))
      expect(await f.dial('a', body.token)).toBe(403)
    },
  )

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

describe('inside', () => {
  it('is component-wise and case-exact', () => {
    const root = join(sep, 'srv', 'Root')
    expect(inside(root, join(root, 'a.md'))).toBe(true)
    expect(inside(root, join(sep, 'srv', 'Root-private', 'a.md'))).toBe(false)
    expect(inside(root, join(sep, 'srv', 'root', 'a.md'))).toBe(false)
    expect(inside(root, root)).toBe(false)
  })
})

/** The 8.3 name of an existing path (itself when it has none). Fails loudly on anything else. */
const shortName = (path: string): string => {
  const { stdout: out } = spawnSync(
    'cmd.exe',
    ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`],
    { encoding: 'utf8', windowsVerbatimArguments: true },
  )
  const short = out.trim().split(/\r?\n/).pop() as string
  statSync(short) // throws if the command misfired
  return short
}

describe.runIf(process.platform === 'win32')('root on Windows', () => {
  it('refuses another drive', () => {
    expect(inside('C:\\root', 'C:\\root\\a.md')).toBe(true)
    expect(inside('C:\\root', 'D:\\root\\a.md')).toBe(false)
    expect(inside('C:\\Root', 'C:\\root\\a.md')).toBe(false) // another directory when case-sensitive
    expect(inside('C:\\', 'C:\\a.md')).toBe(true)
    expect(inside('C:\\root', '\\\\server\\share\\root\\a.md')).toBe(false)
  })

  it('judges verbatim paths, short names and junctions by where they land', async () => {
    let f: Fixture | undefined
    const at = (...parts: string[]) => join((f as Fixture).dir, ...parts)
    const paths: Record<string, () => string> = {
      verbatimOut: () => `\\\\?\\${at('root-private', 'x.md')}`,
      verbatimDrive: () => '\\\\?\\D:\\root\\a.md',
      shortOut: () => join(shortName(at('root-private')), 'x.md'),
      junction: () => at('root', 'link', 'x.md'),
      shortIn: () => join(shortName(at('root')), 'a.md'),
      verbatimIn: () => `\\\\?\\${at('root', 'a.md')}`,
    }
    f = await start({
      resolve: async (id) =>
        paths[id as string] ? { path: paths[id as string]?.() as string, role: 'edit' } : null,
    })
    for (const id of ['verbatimOut', 'verbatimDrive', 'shortOut', 'junction'])
      expect((await f.session(id)).status, id).toBe(404)
    if (BIN) {
      for (const id of ['shortIn', 'verbatimIn']) expect((await f.session(id)).status, id).toBe(200)
    }
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

  it('a bin function is not called at startup, and its failure is 503 busy with an event', async () => {
    let calls = 0
    const f = await start({
      bin: async () => {
        calls++
        throw new Error('not installed yet')
      },
    })
    expect(calls).toBe(0)
    const res = await f.session('a')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'busy' })
    expect(f.events.some((e) => e.type === 'error')).toBe(true)
    await f.session('a')
    expect(calls).toBe(2) // asked again: an install in between is picked up
  })
})

describe('a bin function that gives no path or throws a non-Error', () => {
  it.each([
    ['undefined', async () => undefined as unknown as string, /did not give a path/],
    ['an empty string', async () => '', /did not give a path/],
    [
      'a thrown string',
      async (): Promise<string> => {
        throw 'plain'
      },
      /plain/,
    ],
  ])('%s is 503 busy with a NoPeditError message, not the PATH', async (_n, bin, msg) => {
    const f = await start({ bin })
    const res = await f.session('a')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'busy' })
    const err = f.events.find((e) => e.type === 'error')
    expect(err && 'message' in err ? err.message : '').toMatch(msg)
  })
})

function tmpdirOf(): string {
  return tmpRoot().dir
}

describe.skipIf(!FAKE)('peditRoutes sharing', () => {
  // Answers share with shared and peers, unshare with unshared, close with room_ended. It logs
  // each command frame to `<script>.log`.
  function sharer() {
    const { dir } = tmpRoot()
    const bin = fakePedit(
      dir,
      'pedit',
      `const fs = require('node:fs')
if (process.argv[2] === '--version') { console.log('1.2.3'); process.exit(0) }
const send = (o) => {
  const b = Buffer.from(JSON.stringify(o))
  const h = Buffer.alloc(9)
  h[0] = 4
  h.writeUInt32BE(b.length, 5)
  process.stdout.write(Buffer.concat([h, b]))
}
send({ event: 'listening', generation: 'g', serve: 2 })
process.stdin.on('data', (d) => {
  const c = d.subarray(9).toString()
  fs.appendFileSync(__filename + '.log', c + '\\n')
  const { cmd, id } = JSON.parse(c)
  if (cmd === 'share') {
    send({ event: 'shared', id, room: 'r1', links: { edit: 'r1.e', read: 'r1.r' }, keptUntil: 0, resumed: false })
    send({ event: 'peers', peers: [{ name: 'ada', access: 'edit' }] })
  } else if (cmd === 'unshare') send({ event: 'unshared', id })
  else if (cmd === 'comment') {
    send({ event: 'comments', threads: [{ id: 't1', quote: 'q', resolved: false, from: 1, to: 4, messages: [] }] })
    send({ event: 'commented', id, thread: 't1', message: 'm1' })
  } else if (cmd === 'reply') send({ event: 'replied', id, thread: 't1', message: 'm2' })
  else if (cmd === 'resolve') send({ event: 'resolved', id, thread: 't1', resolved: true })
  else if (cmd === 'status' || cmd === 'keep')
    send({ event: 'status', id, room: 'r1', links: { edit: 'r1.e', read: 'r1.r' }, keep: 60, host: 'away', ends: 5, lifeEnd: 9 })
  else send({ event: 'room_ended', id, reason: 'closed' })
})
process.stdin.on('end', () => process.exit(0))
`,
    )
    return { bin, log: () => readFileSync(`${bin}.js.log`, 'utf8').trim().split('\n') }
  }

  it('shares a file under root, maps the events, and keeps the child up while shared', async () => {
    const { bin, log } = sharer()
    const f = await start({ bin, idleMs: 200 })
    await f.token('a') // the routes served it under id "a"
    const path = join(f.root, 'a.md')
    expect(await f.routes.share(path, { keep: '0' })).toMatchObject({ type: 'shared', room: 'r1' })
    expect(log()).toEqual(['{"cmd":"share","id":"c1","keep":"0"}'])
    await vi.waitFor(() => expect(f.events.some((e) => e.type === 'peers')).toBe(true))
    const room = f.events.filter((e) => e.type === 'shared' || e.type === 'peers')
    expect(room.map((e) => [e.type, 'id' in e && e.id])).toEqual([
      ['shared', 'a'],
      ['peers', 'a'],
    ])
    await sleep(700)
    expect(f.events.some((e) => e.type === 'stopped')).toBe(false)
    await f.routes.unshare(path)
    expect(f.events).toContainEqual({ type: 'unshared', id: 'a', path: expect.any(String) })
    await vi.waitFor(() => expect(f.events.some((e) => e.type === 'stopped')).toBe(true))
    await f.routes.close(path)
    expect(log().at(-1)).toBe('{"cmd":"close","id":"c1"}')
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: 'room_ended', reason: 'closed' }),
    )
  })

  it('reports a kept file without a share, and changes its keep', async () => {
    const { bin, log } = sharer()
    const f = await start({ bin })
    const path = join(f.root, 'a.md')
    expect(await f.routes.status(path)).toEqual({
      room: 'r1',
      links: { edit: 'r1.e', read: 'r1.r' },
      keep: 60,
      host: 'away',
      ends: 5,
      lifeEnd: 9,
    })
    expect(await f.routes.keep(path, '3d')).toMatchObject({ room: 'r1' })
    expect(log()).toEqual(['{"cmd":"status","id":"c1"}', '{"cmd":"keep","id":"c2","keep":"3d"}'])
  })

  it('starts, answers and resolves threads by path', async () => {
    const { bin, log } = sharer()
    const f = await start({ bin })
    const path = join(f.root, 'a.md')
    expect(await f.routes.comment(path, { from: 1, to: 4, body: 'Hm' })).toEqual({
      thread: 't1',
      message: 'm1',
    })
    expect(f.events).toContainEqual({
      type: 'comments',
      id: null, // the path was not served under an id
      path: expect.any(String),
      threads: [{ id: 't1', quote: 'q', resolved: false, from: 1, to: 4, messages: [] }],
    })
    expect(await f.routes.reply(path, 't1', 'Yes')).toEqual({ message: 'm2' })
    await f.routes.resolve(path, 't1', true)
    expect(log()).toEqual([
      '{"cmd":"comment","id":"c1","from":1,"to":4,"body":"Hm"}',
      '{"cmd":"reply","id":"c2","thread":"t1","body":"Yes"}',
      '{"cmd":"resolve","id":"c3","thread":"t1","resolved":true}',
    ])
  })

  it('refuses a path the routes would refuse, without starting a child', async () => {
    const { bin, log } = sharer()
    const f = await start({ bin })
    const bad = [
      join(f.dir, 'root-private/x.md'),
      join(f.root, 'link/x.md'),
      join(f.root, 'nope.md'),
      f.root,
    ]
    for (const p of bad) {
      await expect(f.routes.share(p), p).rejects.toThrow('file not found')
      await expect(f.routes.status(p), p).rejects.toThrow('file not found')
      await expect(f.routes.keep(p, '1d'), p).rejects.toThrow('file not found')
      await expect(f.routes.comment(p, { from: 0, to: 1, body: 'x' }), p).rejects.toThrow(
        'file not found',
      )
      await expect(f.routes.reply(p, 't', 'x'), p).rejects.toThrow('file not found')
      await expect(f.routes.resolve(p, 't', true), p).rejects.toThrow('file not found')
    }
    await expect(f.routes.share('a.md')).rejects.toThrow(/absolute/)
    expect(f.events.filter((e) => e.type === 'started')).toEqual([])
    expect(() => log()).toThrow() // the fake never ran
  })
})
