// A local app whose editor is bound to the document `pedit serve` holds.
// Usage: node app.mjs <file.md>
// pedit listens on a Unix socket only; this server is the app's own, on
// 127.0.0.1, and forwards the page's WebSocket to that socket frame for frame.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import { build } from 'esbuild'
import { WebSocket, WebSocketServer } from 'ws'

const file = process.argv[2]
if (!file) {
  console.error('usage: node app.mjs <file>')
  process.exit(2)
}

// pedit's stdin is a pipe: when this process ends, pedit sees it close, saves
// the file and exits. PEDIT can name a binary that is not on the PATH.
const pedit = spawn(process.env.PEDIT || 'pedit', ['serve', file, '--json', '--app', 'sample'], {
  stdio: ['pipe', 'pipe', 'inherit'],
})
// Exit codes: 0 normal, 1 error, 2 usage, 3 another process serves the file.
pedit.on('exit', (code) => process.exit(code ?? 1))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => pedit.stdin.end())

// pedit prints one JSON event per line. The first says where it listens; a
// refusal or a failure arrives as an event too, before pedit exits.
const lines = createInterface({ input: pedit.stdout })
const socket = await new Promise((resolve) => {
  lines.on('line', (line) => {
    const event = JSON.parse(line)
    if (event.event === 'listening') resolve(event.socket)
    else if (event.event === 'held') {
      console.error(`${file} is already served by pid ${event.pid}${event.app ? `, app ${event.app}` : ''}`)
    } else if (event.event === 'error') {
      console.error(`pedit: ${event.message}`)
    }
  })
})

const bundle = await build({
  entryPoints: ['page.mjs'],
  bundle: true,
  format: 'esm',
  write: false,
})
const script = bundle.outputFiles[0].text
const html = await readFile(new URL('index.html', import.meta.url), 'utf8')

// Another user on this machine can reach 127.0.0.1 too, and can forge an Origin
// header. A secret per run, which only the printed URL carries, keeps them out:
// the page, its script and the bridge all live under /<token>/.
const token = randomBytes(32).toString('hex')
const base = `/${token}/`

const headers = {
  'content-security-policy':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  'x-content-type-options': 'nosniff',
}

const server = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]
  if (path === `${base}page.js`) {
    res.writeHead(200, { ...headers, 'content-type': 'text/javascript' }).end(script)
  } else if (path === base) {
    res.writeHead(200, { ...headers, 'content-type': 'text/html' }).end(html)
  } else {
    res.writeHead(404, headers).end()
  }
})

// Any page in the user's browser can open a WebSocket to 127.0.0.1, so only
// this app's own page may use the bridge: a browser always sends the Origin
// of the page that opens the connection. A client that is not a browser can
// send any Origin, so the token is required as well.
const ownOrigin = () => `http://127.0.0.1:${server.address().port}`
const allowed = ({ origin, req }) =>
  origin === ownOrigin() && (req.url ?? '').split('?')[0].startsWith(base)

// One upstream connection per page connection, frames passed through as they are.
const wss = new WebSocketServer({ server, verifyClient: allowed })
wss.on('connection', (page) => {
  // Dial the socket ourselves rather than use a ws+unix:// URL, which cannot
  // carry a path with a space (macOS: "Application Support").
  const upstream = new WebSocket('ws://pedit/', { createConnection: () => connect(socket) })
  const queued = []
  page.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
    else queued.push([data, isBinary])
  })
  upstream.on('open', () => {
    for (const [data, binary] of queued.splice(0)) upstream.send(data, { binary })
  })
  upstream.on('message', (data, isBinary) => page.send(data, { binary: isBinary }))
  page.on('close', () => upstream.close())
  upstream.on('close', () => page.close())
  upstream.on('error', (e) => {
    console.error('upstream:', e.message)
    page.close()
  })
  page.on('error', () => upstream.close())
})

server.listen(0, '127.0.0.1', () => {
  console.log(`Editing ${file}: http://127.0.0.1:${server.address().port}${base}`)
})
