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
    const [, origin, host] = line.match(/(http:\/\/(127\.0\.0\.1:\d+))\//)
    for (const [from, want] of [
      [origin, true],
      ['https://unrelated.example', false],
      [`http://localhost:${host.split(':')[1]}`, false],
      [undefined, false],
    ]) {
      const { ws, ok } = await open(`ws://${host}/file`, from)
      assert.equal(ok, want, `origin ${from}`)
      ws.close()
    }
  } finally {
    app.kill('SIGTERM')
  }
})
