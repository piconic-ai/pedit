// Usage: npm run build && node server.mjs
// PEDIT=/path/to/pedit if pedit is not on the PATH; PORT to change the port (default 3000);
// PEDIT_RELAY for a relay other than https://edit.piconic.ai (e.g. http://127.0.0.1:8787);
// REVIEW_PAGE (e.g. http://127.0.0.1:3001/) to share to a page that holds <pedit-review>.
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { peditRoutes } from '@pedit/serve/hono'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

const port = Number(process.env.PORT ?? 3000)
// The origin is fixed before the server starts, so the port must be a real one (no 0).
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`PORT must be a port number from 1 to 65535, not ${process.env.PORT}`)
  process.exit(2)
}
const origin = `http://127.0.0.1:${port}`
const root = fileURLToPath(new URL('content', import.meta.url))
await mkdir(root, { recursive: true })
await stat(`${root}/demo.md`).catch(() => writeFile(`${root}/demo.md`, '# Hello\n')) // pedit edits existing files
// Events name the file by its real path, also when no page has opened it yet.
const file = await realpath(`${root}/demo.md`)

// Reviewers open the review page (REVIEW_PAGE) when it is set, else the relay's own editor. The
// sample always passes this relay to share(), so the links and these URLs agree even if the
// project config sets another.
const relay = (process.env.PEDIT_RELAY ?? 'https://edit.piconic.ai').replace(/\/+$/, '')
const reviewPage = process.env.REVIEW_PAGE ? new URL(process.env.REVIEW_PAGE) : null
if (reviewPage) reviewPage.hash = ''
const reviewerUrl = (link) => {
  // The review page reads `#<room>.<key>` itself: the link goes after the `#` as it is.
  if (reviewPage) return `${reviewPage.href}#${link}`
  const dot = link.indexOf('.')
  return `${relay}/r/${link.slice(0, dot)}#${link.slice(dot + 1)}`
}
const reviewerLinks = (links) =>
  Object.fromEntries(Object.entries(links).map(([k, v]) => [k, reviewerUrl(v)]))

// What the share panel shows: the room (as the page gets it) and the last peers. One file, so one
// state. Every change goes to the pages as the whole state, so a page that missed events, or
// reconnected, still ends up showing what is true.
const state = { shared: null, peers: null }
const listeners = new Set()
const publish = (event) => {
  if (event.type === 'shared') state.shared = event
  else if (event.type === 'peers') state.peers = event
  else {
    // unshared, room_ended, or pedit stopped (it exited or crashed): nothing is shared any more.
    state.shared = null
    state.peers = null
  }
  const ended = event.type === 'room_ended' ? event.reason : undefined
  for (const send of listeners) send({ ...state, ended })
}

// Routes: the page, its script, and pedit under /edit.
const app = new Hono()
app.use(async (c, next) => {
  await next()
  c.header('x-content-type-options', 'nosniff')
  c.header(
    'content-security-policy',
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:*; style-src 'self' 'unsafe-inline'",
  )
})
app.get('/', serveStatic({ path: './index.html' }))
app.get('/page.js', serveStatic({ root: './public' }))
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
const routes = peditRoutes({
  upgradeWebSocket,
  root,
  origins: [origin],
  app: 'serve-app',
  bin: process.env.PEDIT,
  // Why a page saw `busy`: pedit missing, too old, or failed to start. Never log a token.
  onEvent: (e) => {
    if (e.type === 'error') return console.error(`pedit: ${e.message}`)
    if (
      ['peers', 'shared', 'unshared', 'room_ended', 'stopped'].includes(e.type) &&
      e.path === file
    ) {
      publish({ ...e, ...(e.links && { links: reviewerLinks(e.links) }) })
    }
  },
  // Which file an id names, and what the caller may do with it. There is no login here, so every
  // caller may edit demo.md: that is why the server listens on loopback only.
  resolve: async (id) => (id === 'demo' ? { path: `${root}/demo.md`, role: 'edit' } : null),
})
app.route('/edit', routes)

// The share routes change what leaves this machine, so they are guarded like /edit: the app's own
// origin, 127.0.0.1 as the Host, and JSON only for POST. A same-origin EventSource sends no Origin.
const guardShare = async (c, next) => {
  if (c.req.header('host') !== `127.0.0.1:${port}`) return c.body(null, 404)
  const o = c.req.header('origin')
  const sameOrigin = c.req.method === 'GET' && c.req.header('sec-fetch-site') === 'same-origin'
  if (o !== origin && !(o === undefined && sameOrigin)) return c.json({ error: 'forbidden' }, 403)
  if (c.req.method === 'POST' && !c.req.header('content-type')?.startsWith('application/json')) {
    return c.json({ error: 'json only' }, 403)
  }
  await next()
}
// A failure from share, unshare or close (pedit missing, relay down) is the user's to read.
const answer = (c, run) => run().catch((e) => c.json({ error: String(e?.message ?? e) }, 409))
app.use('/share', guardShare)
app.use('/share/*', guardShare)
app.post('/share', (c) =>
  answer(c, async () => {
    const { keep, choice } = await c.req.json().catch(() => ({}))
    const r = await routes.share(file, {
      relay,
      keep,
      choice,
      // The relay admits only these page origins to the room.
      ...(reviewPage && { origins: [reviewPage.origin] }),
    })
    return c.json(r.type === 'shared' ? { ...r, links: reviewerLinks(r.links) } : r)
  }),
)
app.post('/share/unshare', (c) =>
  answer(c, async () => {
    await routes.unshare(file)
    return c.json({})
  }),
)
app.post('/share/close', (c) =>
  answer(c, async () => {
    await routes.close(file)
    return c.json({})
  }),
)
app.get('/share/events', (c) =>
  streamSSE(c, async (stream) => {
    const send = (s) => stream.writeSSE({ event: 'state', data: JSON.stringify(s) })
    // Listen before the first write, so nothing published during it is missed or leaked.
    const closed = new Promise((resolve) => stream.onAbort(resolve))
    listeners.add(send)
    try {
      if (!stream.aborted) {
        await send(state)
        await closed
      }
    } finally {
      listeners.delete(send)
    }
  }),
)

// Server. When it exits, pedit sees its stdin close, saves the file and exits too.
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () =>
  console.log(`Editing ${root}/demo.md: ${origin}/`),
)
injectWebSocket(server)
