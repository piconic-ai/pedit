// Run with: PEDIT=/path/to/pedit node --test (builds public/page.js first)
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { request } from 'node:http'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { WebSocket } from 'ws'

const skip = process.env.PEDIT ? false : 'set PEDIT to a pedit binary'

function post(origin, path, headers) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, origin), { method: 'POST', headers }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

test('the app serves its page, guards the routes, and bridges the file', { skip }, async () => {
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore' })
  const app = spawn('node', ['server.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] })
  try {
    const line = await new Promise((resolve) =>
      createInterface({ input: app.stdout }).once('line', resolve),
    )
    const [, origin, host] = line.match(/(http:\/\/(127\.0\.0\.1:\d+))\//)

    const page = await fetch(`${origin}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/)
    assert.equal((await fetch(`${origin}/page.js`)).status, 200)

    const ok = { origin }
    // A wrong Host or Origin is refused; an unknown id is 404.
    assert.equal(await post(origin, '/edit/demo/session', { ...ok, host: 'evil.test' }), 404)
    assert.equal(await post(origin, '/edit/demo/session', { origin: 'http://evil.test' }), 403)
    assert.equal(await post(origin, '/edit/nope/session', ok), 404)

    const session = await fetch(`${origin}/edit/demo/session`, { method: 'POST', headers: ok })
    assert.equal(session.status, 200)
    const { token, role } = await session.json()
    assert.equal(role, 'edit')

    const status = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${host}/edit/demo/doc?token=${token}`, { origin })
      ws.on('open', () => (ws.close(), resolve(101)))
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode))
      ws.on('error', () => {})
    })
    assert.equal(status, 101)
  } finally {
    app.kill('SIGTERM')
  }
})
