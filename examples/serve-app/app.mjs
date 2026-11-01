// A local app whose editor is bound to the document `pedit serve` holds.
// Usage: node app.mjs <file.md>
// pedit listens on a Unix socket only; this server is the app's own, on
// 127.0.0.1, and forwards the page's WebSocket to that socket frame for frame.
import { spawn } from 'node:child_process'
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
pedit.on('exit', (code) => process.exit(code ?? 1))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => pedit.stdin.end())

// The first line pedit prints says where it listens.
const lines = createInterface({ input: pedit.stdout })
const socket = await new Promise((resolve) => {
  lines.on('line', (line) => {
    const event = JSON.parse(line)
    if (event.event === 'listening') resolve(event.socket)
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

const server = createServer((req, res) => {
  if (req.url === '/page.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(script)
  } else {
    res.writeHead(200, { 'content-type': 'text/html' }).end(html)
  }
})

// One upstream connection per page connection, frames passed through as they are.
const wss = new WebSocketServer({ server })
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
  console.log(`Editing ${file}: http://127.0.0.1:${server.address().port}/`)
})
