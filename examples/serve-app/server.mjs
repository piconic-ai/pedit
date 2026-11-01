// A local app whose editor is bound to the file `pedit serve` holds, through @pedit/serve.
// Usage: node server.mjs   (PEDIT=/path/to/pedit if pedit is not on the PATH; PORT to pin the port)
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { peditRoutes } from '@pedit/serve/hono'
import { build } from 'esbuild'
import { Hono } from 'hono'

const here = (name) => fileURLToPath(new URL(name, import.meta.url))
const root = here('content')
await mkdir(root, { recursive: true })
// The file must exist: pedit serve edits a file, it does not create one.
await stat(`${root}/demo.md`).catch(() => writeFile(`${root}/demo.md`, '# Hello\n'))

const resolveDep = (name) =>
  fileURLToPath(import.meta.resolve(`${name}/package.json`)).replace(/\/package\.json$/, '')
const bundle = await build({
  entryPoints: [here('page.mjs')],
  bundle: true,
  format: 'esm',
  write: false,
  // One copy of each, or Yjs refuses to run.
  alias: Object.fromEntries(['yjs', 'y-protocols', 'lib0'].map((n) => [n, resolveDep(n)])),
})
const script = bundle.outputFiles[0].text
const html = await readFile(here('index.html'), 'utf8')

const headers = {
  'content-security-policy':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  'x-content-type-options': 'nosniff',
}

const app = new Hono()
app.get('/', (c) => c.body(html, 200, { ...headers, 'content-type': 'text/html' }))
app.get('/page.js', (c) => c.body(script, 200, { ...headers, 'content-type': 'text/javascript' }))
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 0),
  hostname: '127.0.0.1',
})
await new Promise((resolve) => server.once('listening', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

// There is no authentication here: anyone who can reach this origin on this machine edits the file.
// That is why the server listens on 127.0.0.1 only and allowRemote stays false.
const routes = peditRoutes({
  upgradeWebSocket,
  root,
  origins: [origin],
  app: 'serve-app',
  bin: process.env.PEDIT,
  // The fixed id `demo` is the only file this app serves.
  resolve: async (id) => (id === 'demo' ? { path: `${root}/demo.md`, role: 'edit' } : null),
  onEvent: (e) => console.error(JSON.stringify(e)),
})
app.route('/edit', routes)
injectWebSocket(server)

// Ctrl+C: end pedit's children so they save the file and remove their sockets and locks.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => routes.close().finally(() => process.exit(0)))
}
console.log(`Editing ${root}/demo.md: ${origin}/`)
