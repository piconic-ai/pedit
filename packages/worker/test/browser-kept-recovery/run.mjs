import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const workerDir = resolve(dir, '../..')
const require = createRequire(resolve(workerDir, 'package.json'))
const wrangler = resolve(dirname(require.resolve('wrangler/package.json')), 'bin/wrangler.js')
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'))
const esbuild = wranglerRequire('esbuild')
const chrome =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const temp = await mkdtemp(resolve(tmpdir(), 'pedit-kept-browser-'))
let worker,
  browser,
  workerLog = '',
  chromeLog = ''
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function port() {
  const server = net.createServer()
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  )
  const value = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return value
}
async function until(fn, label) {
  for (let i = 0; i < 200; i++) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('FAIL:')) throw error
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
function startChrome(debug, url) {
  const child = spawn(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      `--user-data-dir=${temp}/chrome`,
      `--remote-debugging-port=${debug}`,
      url,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  child.stderr.on('data', (chunk) => {
    chromeLog += chunk
  })
  child.on('error', (error) => {
    chromeLog += error.message
  })
  return child
}
async function status(debug, phase) {
  const pages = await (await fetch(`http://127.0.0.1:${debug}/json`)).json()
  const page = pages.filter((x) => x.type === 'page' && x.url.endsWith(`?autorun=${phase}`)).at(-1)
  if (!page) return null
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  const result = await new Promise((resolve) => {
    ws.onmessage = (event) => resolve(JSON.parse(event.data))
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: 'document.querySelector("#status")?.textContent',
          returnByValue: true,
        },
      }),
    )
  })
  ws.close()
  const text = result.result?.result?.value
  if (typeof text === 'string' && text.startsWith('FAIL:')) throw new Error(text)
  return text === 'Ready' ? null : text
}
try {
  const workerPort = await port(),
    debugPort = await port()
  await esbuild.build({
    entryPoints: [resolve(dir, 'browser.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    nodePaths: [resolve(workerDir, '../protocol/node_modules')],
    outfile: resolve(temp, 'bundle.txt'),
  })
  const template = await readFile(resolve(dir, 'worker.template.txt'), 'utf8')
  await writeFile(
    resolve(temp, 'worker.ts'),
    template.replaceAll('__WORKER_SRC__', resolve(workerDir, 'src')),
  )
  await writeFile(
    resolve(temp, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'pedit-browser-kept-test',
      main: 'worker.ts',
      compatibility_date: '2026-08-20',
      durable_objects: { bindings: [{ name: 'ROOM', class_name: 'TestRoom' }] },
      migrations: [{ tag: 'test-v1', new_sqlite_classes: ['TestRoom'] }],
      r2_buckets: [{ binding: 'BLOBS', bucket_name: 'test-blobs' }],
    }),
  )
  worker = spawn(
    process.execPath,
    [
      wrangler,
      'dev',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(workerPort),
      '--inspector-port',
      '0',
      '--config',
      resolve(temp, 'wrangler.jsonc'),
      '--persist-to',
      resolve(temp, 'state'),
    ],
    {
      cwd: workerDir,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: resolve(temp, 'config'),
        WRANGLER_SEND_METRICS: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  worker.stdout.on('data', (chunk) => {
    workerLog += chunk
  })
  worker.stderr.on('data', (chunk) => {
    workerLog += chunk
  })
  await until(async () => (await fetch(`http://127.0.0.1:${workerPort}/`)).ok, 'local Worker')
  const url = `http://127.0.0.1:${workerPort}/?autorun=`
  browser = startChrome(debugPort, url + 'first')
  const first = await until(() => status(debugPort, 'first'), 'pending edit')
  if (!first.startsWith('PENDING:')) throw new Error(`Unexpected first phase: ${first}`)
  browser.kill('SIGKILL')
  await new Promise((resolve) => browser.once('exit', resolve))
  const retryPort = await port()
  browser = startChrome(retryPort, url + 'retry')
  const second = await until(() => status(retryPort, 'retry'), 'recovery')
  if (!second.startsWith('PASS:')) throw new Error(`Unexpected recovery: ${second}`)
  process.stdout.write(`${second}\n`)
} catch (error) {
  process.stderr.write(`${String(error)}\nWorker log:\n${workerLog}\nChrome log:\n${chromeLog}\n`)
  process.exitCode = 1
} finally {
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    browser.kill('SIGTERM')
    await new Promise((resolve) => browser.once('exit', resolve))
  }
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill('SIGTERM')
    await new Promise((resolve) => worker.once('exit', resolve))
  }
  await rm(temp, { recursive: true, force: true })
}
