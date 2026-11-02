// Usage: npm run build && node server.mjs
// PEDIT=/path/to/pedit if pedit is not on the PATH; PORT to change the port (default 3000).
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { peditRoutes } from '@pedit/serve/hono'
import { Hono } from 'hono'

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
app.route(
  '/edit',
  peditRoutes({
    upgradeWebSocket,
    root,
    origins: [origin],
    app: 'serve-app',
    bin: process.env.PEDIT,
    // Why a page saw `busy`: pedit missing, too old, or failed to start. Never log a token.
    onEvent: (e) => e.type === 'error' && console.error(`pedit: ${e.message}`),
    // Which file an id names, and what the caller may do with it. There is no login here, so every
    // caller may edit demo.md: that is why the server listens on loopback only.
    resolve: async (id) => (id === 'demo' ? { path: `${root}/demo.md`, role: 'edit' } : null),
  }),
)

// Server. When it exits, pedit sees its stdin close, saves the file and exits too.
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () =>
  console.log(`Editing ${root}/demo.md: ${origin}/`),
)
injectWebSocket(server)
