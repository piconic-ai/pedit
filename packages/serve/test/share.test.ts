import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServedFiles, type ServeEvent } from '../src/index.ts'
import { FAKE, fakePedit, sleep, tmpRoot, write } from './helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/**
 * A fake pedit that answers commands one at a time, as pedit does: the relay field of a share
 * picks the answer. It logs each command frame as `kind stream json` in `<script>.log`.
 */
function script(serve: number, extra = ''): string {
  return `const fs = require('fs')
const send = (o) => {
  const b = Buffer.from(JSON.stringify(o))
  const h = Buffer.alloc(9)
  h[0] = 4
  h.writeUInt32BE(b.length, 5)
  process.stdout.write(Buffer.concat([h, b]))
}
send({ event: 'listening', generation: 'g', version: 'v9.9.9', serve: ${serve} })
${extra}
let buf = Buffer.alloc(0)
let chain = Promise.resolve()
const answer = async (c) => {
  await new Promise((r) => setTimeout(r, c.relay === 'slow' ? 150 : 0))
  if (c.cmd === 'share') {
    if (c.relay === 'fail') return send({ event: 'error', cmd: 'share', message: 'relay down' })
    if (c.relay === 'choice' && !c.choice)
      return send({ event: 'resume_choice', room: 'r1', choices: [{ choice: 'room', text: 3 }, { choice: 'later' }] })
    send({ event: 'shared', room: 'r1', links: { edit: 'r1.e', read: 'r1.r' }, keptUntil: 5, resumed: false })
  } else if (c.cmd === 'unshare') send({ event: 'unshared' })
  else send({ event: 'room_ended', reason: 'closed' })
}
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d])
  while (buf.length >= 9 && buf.length >= 9 + buf.readUInt32BE(5)) {
    const n = buf.readUInt32BE(5)
    const kind = buf[0]
    const payload = buf.subarray(9, 9 + n).toString()
    fs.appendFileSync(__filename + '.log', kind + ' ' + buf.readUInt32BE(1) + ' ' + payload + '\\n')
    buf = buf.subarray(9 + n)
    if (kind === 5) chain = chain.then(() => answer(JSON.parse(payload)))
  }
})
process.stdin.on('end', () => process.exit(0))
`
}

function setup(js: string, idleMs?: number) {
  const { dir, cleanup } = tmpRoot()
  const bin = fakePedit(dir, 'pedit', js)
  const events: ServeEvent[] = []
  const files = new ServedFiles({ bin, app: 'test-app', idleMs, onEvent: (e) => events.push(e) })
  cleanups.push(cleanup, () => files.close())
  const log = () => {
    try {
      return readFileSync(`${bin}.js.log`, 'utf8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  return { dir, files, events, log }
}

describe.skipIf(!FAKE)('ServedFile commands', () => {
  it('writes kind 5 frames on stream 0 and resolves share on shared', async () => {
    const { dir, files, events, log } = setup(script(2))
    const served = await files.acquire(write(dir, 'a.md'))
    const shared = await served.share({ origins: ['https://cms.example.com'], keep: '1d' })
    expect(shared).toEqual({
      type: 'shared',
      room: 'r1',
      links: { edit: 'r1.e', read: 'r1.r' },
      keptUntil: 5,
      resumed: false,
    })
    expect(log()).toEqual(['5 0 {"cmd":"share","origins":["https://cms.example.com"],"keep":"1d"}'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'shared', room: 'r1' }))
    await served.unshare()
    await served.close()
    expect(log().slice(1)).toEqual(['5 0 {"cmd":"unshare"}', '5 0 {"cmd":"close"}'])
  })

  it('resolves share with a choice on resume_choice, and rejects on an error for share', async () => {
    const { dir, files } = setup(script(2))
    const served = await files.acquire(write(dir, 'a.md'))
    expect(await served.share({ relay: 'choice' })).toEqual({
      type: 'choice',
      room: 'r1',
      choices: [{ choice: 'room', text: 3 }, { choice: 'later' }],
    })
    expect(await served.share({ relay: 'choice', choice: 'room' })).toMatchObject({
      type: 'shared',
    })
    await expect(served.share({ relay: 'fail' })).rejects.toThrow('relay down')
    // The error did not end the child.
    await expect(served.unshare()).resolves.toBeUndefined()
  })

  it('answers queued commands in order', async () => {
    const { dir, files } = setup(script(2))
    const served = await files.acquire(write(dir, 'a.md'))
    const order: string[] = []
    await Promise.all([
      served.share({ relay: 'slow' }).then(() => order.push('share')),
      served.unshare().then(() => order.push('unshare')),
      served.close().then(() => order.push('close')),
    ])
    expect(order).toEqual(['share', 'unshare', 'close'])
  })

  it('refuses share against serve 1 without writing a frame', async () => {
    const { dir, files, log } = setup(script(1))
    const served = await files.acquire(write(dir, 'a.md'))
    await expect(served.share()).rejects.toThrow(/serve 2/)
    await sleep(100)
    expect(log()).toEqual([])
  })

  it('does not stop a shared child for idleness, and does after unshare', async () => {
    const { dir, files, events } = setup(script(2), 200)
    const served = await files.acquire(write(dir, 'a.md'))
    await served.share()
    await sleep(700)
    expect(events.some((e) => e.type === 'stopped')).toBe(false)
    await served.unshare()
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: 'stopped', path: served.path, reason: 'idle' }),
    )
  })

  it('arms the idle stop again when the relay ends the room', async () => {
    const extra = `process.stdin.once('data', () => setTimeout(() => send({ event: 'room_ended', reason: 'expired' }), 300))`
    const { dir, files, events } = setup(script(2, extra), 200)
    const served = await files.acquire(write(dir, 'a.md'))
    await served.share()
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: 'room_ended', path: served.path, reason: 'expired' }),
    )
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: 'stopped', path: served.path, reason: 'idle' }),
    )
  })

  it('passes peers to onEvent, and takes an event of 10 KiB', async () => {
    const extra = `send({ event: 'peers', peers: [{ name: 'ada', access: 'edit' }], more: 3 })
send({ event: 'peers', peers: [{ name: 'x'.repeat(10 * 1024), access: 'read' }] })`
    const { dir, files, events } = setup(script(2, extra))
    const served = await files.acquire(write(dir, 'a.md'))
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'peers')).toHaveLength(2))
    expect(events).toContainEqual({
      type: 'peers',
      path: served.path,
      peers: [{ name: 'ada', access: 'edit' }],
      more: 3,
    })
    expect(events.some((e) => e.type === 'stopped')).toBe(false)
    await expect(served.share()).resolves.toMatchObject({ type: 'shared' })
  })

  it('rejects pending commands when the child exits', async () => {
    const { dir, files } = setup(script(2, `process.stdin.once('data', () => process.exit(1))`))
    const served = await files.acquire(write(dir, 'a.md'))
    await expect(served.share()).rejects.toThrow(/no longer served/)
  })
})
