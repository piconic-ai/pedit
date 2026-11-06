// Run with: PEDIT=/path/to/pedit node --test (builds public/page.js first)
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { WebSocket } from 'ws'

const reviewPage = 'http://127.0.0.1:3001/'
const skip = process.env.PEDIT ? false : 'set PEDIT to a pedit binary'

function post(origin, path, headers, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, origin), { method, headers }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

test('the app serves its page, guards the routes, and bridges the file', { skip }, async () => {
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore' })
  // A free port, so the test does not collide with a running sample on 3000.
  const port = await new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
  const app = spawn('node', ['server.mjs'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: String(port), REVIEW_PAGE: reviewPage },
  })
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

    // The share routes: wrong Origin or Host is refused, and so is a body that is not JSON.
    const json = { ...ok, 'content-type': 'application/json' }
    assert.equal(await post(origin, '/share', { origin: 'http://evil.test' }), 403)
    assert.equal(await post(origin, '/share/unshare', { ...json, host: 'evil.test' }), 404)
    assert.equal(await post(origin, '/share/close', { origin: 'http://evil.test' }), 403)
    assert.equal(await post(origin, '/share', ok), 403)
    assert.equal(await post(origin, '/share/events', { origin: 'http://evil.test' }, 'GET'), 403)
    // The stream starts with the whole share state, and sends it again on every change.
    const events = await fetch(`${origin}/share/events`, { headers: ok })
    assert.match(events.headers.get('content-type'), /^text\/event-stream/)
    const reader = events.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffered = ''
    const nextState = async () => {
      for (;;) {
        const end = buffered.indexOf('\n\n')
        if (end >= 0) {
          const message = buffered.slice(0, end)
          buffered = buffered.slice(end + 2)
          const data = message.match(/^data: (.*)$/m)
          if (message.includes('event: state') && data) return JSON.parse(data[1])
          continue
        }
        const { value, done } = await reader.read()
        if (done) throw new Error('the event stream ended')
        buffered += value
      }
    }
    assert.deepEqual(await nextState(), { shared: null, peers: null })

    // A real share needs a relay (PEDIT_RELAY, e.g. a local worker); keep 0 leaves nothing behind.
    if (process.env.PEDIT_RELAY) {
      const relay = process.env.PEDIT_RELAY.replace(/\/+$/, '')
      const shared = await fetch(`${origin}/share`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ keep: '0' }),
      })
      const result = await shared.json()
      assert.equal(shared.status, 200, result.error)
      assert.equal(result.type, 'shared')
      // REVIEW_PAGE is set: the links open the review page, with the link after the '#'.
      assert.ok(result.links.edit.startsWith(`${reviewPage}#`), result.links.edit)
      assert.ok(result.links.read.startsWith(`${reviewPage}#`), result.links.read)
      assert.ok(!result.links.edit.includes(relay))
      // No page has opened the file yet, and the stream still hears of the share and its end.
      let s = await nextState()
      while (!s.shared) s = await nextState()
      assert.equal(s.shared.links.edit, result.links.edit)
      assert.equal(await post(origin, '/share/unshare', json), 200)
      do s = await nextState()
      while (s.shared)
    }
    await reader.cancel()

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
