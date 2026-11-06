// Usage: npm run build && node server.mjs
// PORT to change the port (default 3001); PEDIT_RELAY for a relay other than https://edit.piconic.ai.
// After the @pedit/review release, import reviewCSP from '@pedit/review/csp' instead.
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { reviewCSP } from '../../packages/review/dist/csp.js'

const port = Number(process.env.PORT ?? 3001)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT must be a port number, not ${process.env.PORT}`)
  process.exit(2)
}
const relay = (process.env.PEDIT_RELAY ?? 'https://edit.piconic.ai').replace(/\/+$/, '')
// Throws if the relay is not an http(s) URL: better at start than as a broken page.
const csp = reviewCSP({ relay })

const file = (name) => readFile(fileURLToPath(new URL(`public/${name}`, import.meta.url)))
// The relay is the only value put into the HTML, and it goes in an attribute, so it is escaped.
const escapeAttr = (s) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const html = (await file('index.html')).toString().replace('__PEDIT_RELAY__', escapeAttr(relay))
const bundle = await file('assets/pedit-review.js').catch(() => {
  console.error('public/assets/pedit-review.js is missing: run `npm run build` first')
  process.exit(1)
})

const routes = {
  '/': ['text/html; charset=utf-8', html],
  '/assets/pedit-review.js': ['text/javascript; charset=utf-8', bundle],
}

export const server = createServer((req, res) => {
  const route = req.method === 'GET' || req.method === 'HEAD' ? routes[req.url.split('?')[0]] : null
  res.setHeader('Content-Security-Policy', csp)
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Not found\n')
  }
  res.writeHead(200, { 'Content-Type': route[0] })
  res.end(req.method === 'HEAD' ? undefined : route[1])
})

server.listen(port, '127.0.0.1', () =>
  console.log(`Review page: http://127.0.0.1:${server.address().port}/`),
)
