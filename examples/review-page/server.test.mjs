// Run with: npm test (copies the bundle from the workspace build first)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

test('the page and bundle are served with the policy headers', async () => {
  const relay = 'http://127.0.0.1:8787'
  const app = spawn('node', ['server.mjs'], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, PORT: '0', PEDIT_RELAY: relay },
  })
  try {
    const line = await new Promise((resolve) =>
      createInterface({ input: app.stdout }).once('line', resolve),
    )
    const origin = line.match(/(http:\/\/127\.0\.0\.1:\d+)\//)[1]
    for (const path of ['/', '/assets/pedit-review.js']) {
      const res = await fetch(`${origin}${path}`)
      assert.equal(res.status, 200, path)
      const csp = res.headers.get('content-security-policy')
      assert.match(
        csp,
        /(^|; )connect-src http:\/\/127\.0\.0\.1:8787 ws:\/\/127\.0\.0\.1:8787(;|$)/,
      )
      assert.match(csp, /(^|; )script-src 'self'(;|$)/)
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer', path)
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path)
    }
    const page = await (await fetch(`${origin}/`)).text()
    assert.match(page, /<pedit-review relay="http:\/\/127\.0\.0\.1:8787"/)
    assert.deepEqual(page.match(/<script\b[^>]*>/gi), [
      '<script type="module" src="/assets/pedit-review.js">',
    ])

    const missing = await fetch(`${origin}/nope`)
    assert.equal(missing.status, 404)
    assert.equal(missing.headers.get('x-content-type-options'), 'nosniff')
    assert.equal((await fetch(`${origin}/assets/other.js`)).status, 404)
  } finally {
    app.kill('SIGTERM')
  }
})
