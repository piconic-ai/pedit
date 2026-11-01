// Run with: PEDIT=/path/to/pedit node --test
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { WebSocket } from 'ws'

const skip = process.env.PEDIT ? false : 'set PEDIT to a pedit binary'

function open(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {})
    ws.on('open', () => resolve({ ws, ok: true }))
    ws.on('unexpected-response', () => resolve({ ws, ok: false }))
    ws.on('error', () => resolve({ ws, ok: false }))
  })
}

test('the bridge accepts its own page and refuses other origins', { skip }, async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'serve-app-')), 'a.md')
  await writeFile(file, 'private text\n')
  const app = spawn('node', ['app.mjs', file], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const line = await new Promise((resolve) =>
      createInterface({ input: app.stdout }).once('line', resolve),
    )
    const [, origin, host, token] = line.match(/(http:\/\/(127\.0\.0\.1:\d+))\/(\w+)\//)
    for (const [from, want] of [
      [origin, true],
      ['https://unrelated.example', false],
      [`http://localhost:${host.split(':')[1]}`, false],
      [undefined, false],
    ]) {
      const { ws, ok } = await open(`ws://${host}/${token}/file`, from)
      assert.equal(ok, want, `origin ${from}`)
      ws.close()
    }
    // The right Origin is not enough: the token is required, exactly.
    for (const path of ['/file', `/${'0'.repeat(64)}/file`, `/${token}x/file`]) {
      const { ws, ok } = await open(`ws://${host}${path}`, origin)
      assert.equal(ok, false, path)
      ws.close()
    }
    // The page and the script are served only under the token, with a CSP.
    const page = await fetch(`${origin}/${token}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
    assert.equal((await fetch(`${origin}/`)).status, 404)
    assert.equal((await fetch(`${origin}/page.js`)).status, 404)
  } finally {
    app.kill('SIGTERM')
  }
})

test('a second app on the same file prints the refusal and exits with code 3', {
  skip,
}, async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'serve-app-')), 'a.md')
  await writeFile(file, 'text\n')
  const first = spawn('node', ['app.mjs', file], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    await new Promise((resolve) => createInterface({ input: first.stdout }).once('line', resolve))
    const second = spawn('node', ['app.mjs', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    second.stderr.on('data', (d) => (err += d))
    const code = await new Promise((resolve) => second.on('exit', resolve))
    assert.equal(code, 3)
    assert.match(err, /already served by pid \d+/)
  } finally {
    first.kill('SIGTERM')
  }
})
