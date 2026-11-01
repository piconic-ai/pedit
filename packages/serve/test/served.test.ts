import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HeldError,
  LimitError,
  NoPeditError,
  resolvePedit,
  ServedFiles,
  type ServeEvent,
} from '../src/index.ts'
import {
  BIN,
  closed,
  emptyUpdate,
  isSyncStep1,
  nextFrame,
  sleep,
  syncStep1,
  tmpRoot,
  write,
} from './helpers.ts'

const live = BIN ? describe : describe.skip
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

function setup(app = 'test-app', idleMs?: number) {
  const { dir, cleanup } = tmpRoot()
  const events: ServeEvent[] = []
  const files = new ServedFiles({ bin: BIN as string, app, idleMs, onEvent: (e) => events.push(e) })
  cleanups.push(cleanup, () => files.close())
  return { dir, files, events }
}

live('ServedFiles', () => {
  it('serves a file and a dial gets sync step 1', async () => {
    const { dir, files, events } = setup()
    const served = await files.acquire(write(dir, 'a.md'))
    const bridge = await served.dial('edit')
    expect(isSyncStep1(await nextFrame(bridge))).toBe(true)
    expect(events.map((e) => e.type)).toContain('started')
    bridge.close()
  })

  it('shares one child between a hard link, a symlink and a case variant', async () => {
    const { dir, files, events } = setup()
    const a = write(dir, 'a.md')
    linkSync(a, join(dir, 'b.md'))
    symlinkSync(a, join(dir, 'c.md'))
    const first = await files.acquire(a)
    expect(await files.acquire(join(dir, 'b.md'))).toBe(first)
    expect(await files.acquire(join(dir, 'c.md'))).toBe(first)
    const upper = join(dir, 'A.md')
    // Only a case-insensitive file system has this variant.
    if (existsSync(upper)) expect(await files.acquire(upper)).toBe(first)
    expect(events.filter((e) => e.type === 'started')).toHaveLength(1)
  })

  it('does not treat a hard link that an atomic save split as the same file', async () => {
    const { dir, files } = setup()
    const a = write(dir, 'a.md')
    const b = join(dir, 'b.md')
    linkSync(a, b)
    const served = await files.acquire(a)
    writeFileSync(join(dir, '.tmp'), 'replaced\n')
    renameSync(join(dir, '.tmp'), a)
    const other = await files.acquire(b)
    expect(other).not.toBe(served)
    expect(other.path).toBe(b)
    expect(await files.acquire(a)).toBe(served)
  })

  it('forgets a re-indexed inode when the child stops', async () => {
    const { dir, files } = setup('reindex', 300)
    const a = write(dir, 'a.md')
    const served = await files.acquire(a)
    writeFileSync(join(dir, '.tmp'), 'replaced\n')
    renameSync(join(dir, '.tmp'), a)
    expect(await files.acquire(a)).toBe(served) // re-indexed under the new inode
    await sleep(2000) // idle stop
    linkSync(a, join(dir, 'c.md'))
    const again = await files.acquire(join(dir, 'c.md'))
    expect(again.path).toBe(join(dir, 'c.md'))
  })

  it('refuses a file another app holds, naming the holder', async () => {
    const one = setup('app-one')
    const path = write(one.dir, 'a.md')
    await one.files.acquire(path)
    const other = new ServedFiles({ bin: BIN as string, app: 'app-two' })
    cleanups.push(() => other.close())
    const err = await other.acquire(path).catch((e) => e)
    expect(err).toBeInstanceOf(HeldError)
    expect(err.holder.app).toBe('app-one')
    expect(err.holder.pid).toBeGreaterThan(0)
  })

  it('stops an idle child and removes its lock', async () => {
    const { dir, files, events } = setup('idle', 300)
    const served = await files.acquire(write(dir, 'a.md'))
    const bridge = await served.dial('edit')
    await nextFrame(bridge)
    const locks = () => readdirSync(dir).filter((n) => n !== 'a.md')
    expect(locks().length).toBeGreaterThan(0)
    bridge.close()
    await sleep(2000)
    expect(events).toContainEqual({ type: 'stopped', path: served.path, reason: 'idle' })
    expect(locks()).toEqual([])
    expect(await files.acquire(served.path)).not.toBe(served)
  })

  it('reports exited when the child dies, then starts a fresh one', async () => {
    const { dir, files, events } = setup()
    const served = await files.acquire(write(dir, 'a.md'))
    const bridge = await served.dial('edit')
    const gone = closed(bridge)
    const pids = execFileSync('pgrep', ['-f', `serve --root ${dir}`])
      .toString()
      .trim()
      .split('\n')
    for (const pid of pids) process.kill(Number(pid), 'SIGKILL')
    await gone
    await sleep(300)
    expect(events).toContainEqual({ type: 'stopped', path: served.path, reason: 'exited' })
    await expect(served.dial('edit')).rejects.toThrow()
    const next = await files.acquire(served.path)
    expect(isSyncStep1(await nextFrame(await next.dial('edit')))).toBe(true)
  })

  it('limits clients to 8 per file', async () => {
    const { dir, files } = setup()
    const served = await files.acquire(write(dir, 'a.md'))
    const bridges = await Promise.all(Array.from({ length: 8 }, () => served.dial('edit')))
    await expect(served.dial('edit')).rejects.toBeInstanceOf(LimitError)
    bridges[0]?.close()
    await sleep(300)
    ;(await served.dial('edit')).close()
  })

  it('passes a reader update through; pedit closes with 4003', async () => {
    const { dir, files } = setup()
    const served = await files.acquire(write(dir, 'a.md'))
    const bridge = await served.dial('read')
    const done = closed(bridge)
    // pedit sends a reader nothing first; a sync step 1 from the reader gets step 2.
    const step2 = nextFrame(bridge)
    bridge.send(syncStep1)
    expect((await step2)[1]).toBe(1)
    bridge.send(emptyUpdate)
    expect((await done).code).toBe(4003)
  })

  it('serves a name that starts with a dash; a missing file rejects', async () => {
    const { dir, files } = setup()
    const served = await files.acquire(write(dir, '-x.md'))
    expect(isSyncStep1(await nextFrame(await served.dial('edit')))).toBe(true)
    await expect(files.acquire(join(dir, 'nope.md'))).rejects.toThrow()
  })
})

describe('without a usable pedit', () => {
  it('a missing binary is a NoPeditError', async () => {
    const { dir, cleanup } = tmpRoot()
    cleanups.push(cleanup)
    const files = new ServedFiles({ bin: join(dir, 'no-such-pedit'), app: 'x' })
    await expect(files.acquire(write(dir, 'a.md'))).rejects.toBeInstanceOf(NoPeditError)
    const missing = join(dir, 'no-such-pedit')
    await expect(resolvePedit({ bin: missing })).rejects.toBeInstanceOf(NoPeditError)
    await expect(resolvePedit({ bin: 'relative/pedit' })).rejects.toBeInstanceOf(NoPeditError)
  })

  it('resolvePedit refuses a group-writable binary and accepts a sound one', async () => {
    const { dir, cleanup } = tmpRoot()
    cleanups.push(cleanup)
    const fake = write(dir, 'pedit', '#!/bin/sh\necho 1.2.3\n')
    chmodSync(fake, 0o775)
    await expect(resolvePedit({ bin: fake })).rejects.toBeInstanceOf(NoPeditError)
    chmodSync(fake, 0o755)
    expect(await resolvePedit({ bin: fake })).toEqual({ bin: fake, version: '1.2.3' })
  })
})
