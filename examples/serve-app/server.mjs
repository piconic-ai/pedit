// Usage: npm run build && node server.mjs   (PEDIT=/path/to/pedit if pedit is not on the PATH)
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { createNodeWebSocket } from '@hono/node-ws'
import { peditRoutes } from '@pedit/serve/hono'
import { Hono } from 'hono'

const root = new URL('content', import.meta.url).pathname
await mkdir(root, { recursive: true })
await stat(`${root}/demo.md`).catch(() => writeFile(`${root}/demo.md`, '# Hello\n')) // pedit does not create files

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

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 0),
  hostname: '127.0.0.1',
})
await new Promise((resolve) => server.once('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

// No login: anyone who can reach this origin edits the file, so it listens on loopback only.
const routes = peditRoutes({
  upgradeWebSocket,
  root,
  origins: [origin],
  app: 'serve-app',
  bin: process.env.PEDIT,
  resolve: async (id) => (id === 'demo' ? { path: `${root}/demo.md`, role: 'edit' } : null),
})
app.route('/edit', routes)
injectWebSocket(server)
for (const s of ['SIGINT', 'SIGTERM'])
  process.on(s, () => routes.close().finally(() => process.exit(0)))
console.log(`Editing ${root}/demo.md: ${origin}/`)
