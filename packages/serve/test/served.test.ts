import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HeldError,
  LimitError,
  NoPeditError,
  peditVersionOk,
  resolvePedit,
  ServedFiles,
  type ServeEvent,
} from '../src/index.ts'
import { candidateNames, peditEnv } from '../src/resolve.ts'
import {
  BIN,
  closed,
  emptyUpdate,
  eventBytes,
  FAKE,
  fakePedit,
  isSyncStep1,
  nextFrame,
  printEvent,
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

function setup(app = 'test-app', idleMs?: number, graceMs?: number) {
  const { dir, cleanup } = tmpRoot()
  const events: ServeEvent[] = []
  const files = new ServedFiles({
    bin: BIN as string,
    app,
    idleMs,
    graceMs,
    onEvent: (e) => events.push(e),
  })
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

  it.skipIf(!FAKE)('kills a child that writes something that is not a frame', async () => {
    const { dir, cleanup } = tmpRoot()
    cleanups.push(cleanup)
    const fake = fakePedit(
      dir,
      'pedit',
      // The good event and the bad frame (kind 9) in one write: they reach us in one chunk.
      `const good = ${eventBytes({ event: 'listening', generation: 'g' })}
process.stdout.write(Buffer.concat([good, Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0])]))
process.stdin.resume()
`,
    )
    const events: ServeEvent[] = []
    const files = new ServedFiles({ bin: fake, app: 'test-app', onEvent: (e) => events.push(e) })
    cleanups.push(() => files.close())
    await files.acquire(write(dir, 'a.md')) // the event before the bad frame is not lost
    await vi.waitFor(() => expect(events.some((e) => e.type === 'stopped')).toBe(true))
  })

  it.skipIf(!FAKE)('reports the generation, and refuses a child that gives none', async () => {
    const { dir, files } = setup()
    const served = await files.acquire(write(dir, 'a.md'))
    expect(served.generation).toMatch(/^[0-9a-f]{32}$/)
    const old = fakePedit(
      dir,
      'old-pedit',
      `${printEvent({ event: 'listening' })}\nprocess.stdin.resume()\n`,
    )
    const other = new ServedFiles({ bin: old, app: 'test-app' })
    cleanups.push(() => other.close())
    await expect(other.acquire(write(dir, 'b.md'))).rejects.toThrow(/generation/)
  })

  it.skipIf(!FAKE)(
    'reports the version, and passes on update_available once per version',
    async () => {
      const { dir, cleanup } = tmpRoot()
      cleanups.push(cleanup)
      const fake = fakePedit(
        dir,
        'pedit',
        `${printEvent({ event: 'listening', generation: 'g', version: 'v1.2.3', serve: 1 })}
${printEvent({ event: 'update_available', version: 'v9.9.9', url: 'https://example.test/r', security: true })}
${printEvent({ event: 'update_available', version: 'v9.9.9', url: 'https://example.test/r', security: true })}
${printEvent({ event: 'update_available', version: 7, url: 'x' })}
process.stdin.resume()
`,
      )
      const events: ServeEvent[] = []
      const files = new ServedFiles({ bin: fake, app: 'test-app', onEvent: (e) => events.push(e) })
      cleanups.push(() => files.close())
      await files.acquire(write(dir, 'a.md'))
      await vi.waitFor(() => expect(events.some((e) => e.type === 'update_available')).toBe(true))
      expect(events).toContainEqual({
        type: 'started',
        path: expect.any(String),
        version: 'v1.2.3',
        serve: 1,
      })
      expect(events.filter((e) => e.type === 'update_available')).toEqual([
        {
          type: 'update_available',
          version: 'v9.9.9',
          url: 'https://example.test/r',
          security: true,
        },
      ])
    },
  )

  it('shares one child between a hard link, a symlink and a case variant', async () => {
    const { dir, files, events } = setup()
    const a = write(dir, 'a.md')
    linkSync(a, join(dir, 'b.md'))
    let symlinked = true
    try {
      symlinkSync(a, join(dir, 'c.md'))
    } catch {
      symlinked = false // creating a symlink needs a privilege on some Windows hosts
    }
    const first = await files.acquire(a)
    expect(await files.acquire(join(dir, 'b.md'))).toBe(first)
    if (symlinked) expect(await files.acquire(join(dir, 'c.md'))).toBe(first)
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

  // Windows has no signal to kill a child with (and the design never kills one).
  it.skipIf(process.platform === 'win32')(
    'reports exited when the child dies, then starts a fresh one',
    async () => {
      const { dir, files, events } = setup()
      const served = await files.acquire(write(dir, 'a.md'))
      const bridge = await served.dial('edit')
      const gone = closed(bridge)
      const pids = execFileSync('pgrep', ['-f', `serve --stdio --root ${dir}`])
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
    },
  )

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

describe.skipIf(!FAKE)('a child that ignores the end of stdin, as on Windows', () => {
  it('stays indexed and counted until it exits, refuses a second child, and reports once', async () => {
    const { dir, cleanup } = tmpRoot()
    cleanups.push(cleanup)
    const pidFile = join(dir, 'pid')
    const fake = fakePedit(
      dir,
      'pedit',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
${printEvent({ event: 'listening', generation: 'g' })}
setInterval(() => {}, 1000)
`,
    )
    const events: ServeEvent[] = []
    const files = new ServedFiles({
      bin: fake,
      app: 'test-app',
      idleMs: 50,
      graceMs: 200,
      platform: 'win32',
      onEvent: (e) => events.push(e),
    })
    cleanups.push(() => files.close())
    const path = write(dir, 'a.md')
    await files.acquire(path)
    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true))
    // The child still holds the file: a second pedit would only be refused.
    await expect(files.acquire(path)).rejects.toBeInstanceOf(HeldError)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).not.toThrow() // never killed
    const before = events.length
    process.kill(pid) // it exits at last
    await sleep(500)
    expect(events).toHaveLength(before) // no 'stopped' and no second 'error' for the old child
    const next = await files.acquire(path)
    expect(next.generation).toBe('g')
    process.kill(Number(readFileSync(pidFile, 'utf8')))
  })
})

const win = BIN && FAKE && process.platform === 'win32' ? describe : describe.skip

win('ServedFiles on Windows', () => {
  it('stops a child by closing stdin only, and gives up on one that stays, without killing it', async () => {
    const { dir, cleanup } = tmpRoot()
    cleanups.push(cleanup)
    const pidFile = join(dir, 'pid')
    const fake = fakePedit(
      dir,
      'pedit',
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
${printEvent({ event: 'listening', generation: 'g' })}
setInterval(() => {}, 1000) // ignores the end of stdin
`,
    )
    const events: ServeEvent[] = []
    const files = new ServedFiles({
      bin: fake,
      app: 'test-app',
      graceMs: 300,
      onEvent: (e) => events.push(e),
    })
    await files.acquire(write(dir, 'a.md'))
    await files.close() // resolves: it gave up
    expect(events.some((e) => e.type === 'error' && /did not exit/.test(e.message))).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).not.toThrow() // still running: never killed
    process.kill(pid) // the test cleans up its own child
  })

  it('keeps case-distinct files apart in a case-sensitive directory', async (ctx) => {
    const { dir, files } = setup()
    const sensitive = join(dir, 'cs')
    mkdirSync(sensitive)
    try {
      execFileSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', sensitive, 'enable'], {
        stdio: 'pipe',
      })
    } catch (e) {
      return ctx.skip(`this runner cannot make a case-sensitive directory: ${e}`)
    }
    const upper = write(sensitive, 'FOO.txt', 'upper\n')
    const lower = write(sensitive, 'foo.txt', 'lower\n')
    const a = await files.acquire(upper)
    const b = await files.acquire(lower)
    expect(b).not.toBe(a)
    expect([a.path, b.path]).toEqual([upper, lower])
  })

  it('reuses the child for another casing or short name of one file', async () => {
    const { dir, files, events } = setup()
    const first = await files.acquire(write(dir, 'Long File Name.md'))
    expect(await files.acquire(join(dir, 'LONG FILE NAME.MD'))).toBe(first)
    expect(first.path).toBe(join(dir, 'Long File Name.md')) // the spelling on disk
    expect(events.filter((e) => e.type === 'started')).toHaveLength(1)
  })
})

describe('the child environment and binary lookup', () => {
  it('follows PATHEXT for pedit.exe and pedit.com, and falls back to .exe', () => {
    expect(candidateNames(false, '.EXE')).toEqual(['pedit'])
    expect(candidateNames(true, '.COM;.EXE;.BAT')).toEqual(['pedit.com', 'pedit.exe'])
    expect(candidateNames(true, '.BAT;.EXE;.COM')).toEqual(['pedit.exe', 'pedit.com'])
    expect(candidateNames(true, '.BAT;.CMD')).toEqual(['pedit.exe'])
    expect(candidateNames(true, undefined)).toEqual(['pedit.com', 'pedit.exe'])
  })

  it('passes CI on, so a child in CI skips the update check', () => {
    const saved = process.env.CI
    try {
      process.env.CI = 'true'
      expect(peditEnv().CI).toBe('true')
      delete process.env.CI
      expect(peditEnv()).not.toHaveProperty('CI')
    } finally {
      if (saved === undefined) delete process.env.CI
      else process.env.CI = saved
    }
  })

  it('passes what Go needs on Windows, and nothing else', () => {
    const env = peditEnv()
    if (process.platform === 'win32') {
      for (const k of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP'])
        expect(env[k], k).toBeTruthy()
    }
    const allowed = new Set(
      [
        'PATH',
        'HOME',
        'XDG_CONFIG_HOME',
        'TMPDIR',
        'CI',
        'USERPROFILE',
        'APPDATA',
        'LOCALAPPDATA',
        'SystemRoot',
        'windir',
        'SystemDrive',
        'TEMP',
        'TMP',
        'HOMEDRIVE',
        'HOMEPATH',
      ].map((k) => k.toLowerCase()),
    )
    for (const k of Object.keys(env)) expect(allowed.has(k.toLowerCase()), k).toBe(true)
  })

  it.skipIf(!FAKE)('finds pedit on the PATH (pedit.exe on Windows)', async () => {
    const { dir, cleanup } = tmpRoot()
    cleanups.push(cleanup)
    const fake = fakePedit(dir, 'pedit', "console.log('1.2.3')")
    const saved = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT }
    cleanups.push(() => {
      process.env.PATH = saved.PATH
      if (saved.PATHEXT === undefined) delete process.env.PATHEXT
      else process.env.PATHEXT = saved.PATHEXT
    })
    process.env.PATH = [dir, dirname(process.execPath)].join(delimiter) // the fake needs node
    if (process.platform === 'win32') process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD'
    expect(await resolvePedit()).toEqual({ bin: fake, version: '1.2.3' })
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

  it.skipIf(!FAKE)(
    'resolvePedit refuses a group-writable binary and accepts a sound one',
    async () => {
      const { dir, cleanup } = tmpRoot()
      cleanups.push(cleanup)
      const fake = fakePedit(dir, 'pedit', "console.log('1.2.3')")
      if (process.platform !== 'win32') {
        chmodSync(fake, 0o775) // Windows has no mode bits to refuse on
        await expect(resolvePedit({ bin: fake })).rejects.toBeInstanceOf(NoPeditError)
        chmodSync(fake, 0o755)
      }
      expect(await resolvePedit({ bin: fake })).toEqual({ bin: fake, version: '1.2.3' })
    },
  )

  it.skipIf(!FAKE)('refuses a pedit older than the minimum and says how to update', async () => {
    const { dir, cleanup } = tmpRoot()
    cleanups.push(cleanup)
    const old = fakePedit(dir, 'pedit', "console.log('v0.3.0')")
    await expect(resolvePedit({ bin: old })).rejects.toThrow(
      /v0\.3\.0 is too old.*brew.*install\.sh/,
    )
  })

  it('compares versions and accepts the dev forms', () => {
    for (const ok of [
      'v0.5.0',
      '0.5.1',
      'v1.0.0',
      'dev',
      'v0.3.1-0.20261031060942-98b75f74184d',
      'v0.3.1-0.20261031060942-98b75f74184d+dirty',
    ])
      expect(peditVersionOk(ok), ok).toBe(true)
    for (const bad of ['v0.4.9', 'v0.5.0-rc1', '', 'garbage'])
      expect(peditVersionOk(bad), bad).toBe(false)
  })
})

describe('bin as a function', () => {
  const mk = (bin: () => Promise<string>) => {
    const { dir, cleanup } = tmpRoot()
    const files = new ServedFiles({ bin, app: 'fn-bin' })
    cleanups.push(cleanup, () => files.close())
    return { dir, files }
  }

  it('is called for each start, and a failure to run is a NoPeditError', async () => {
    let calls = 0
    const { dir, files } = mk(async () => {
      calls++
      return join(dir, 'no-such-pedit')
    })
    const path = write(dir, 'a.md')
    await expect(files.acquire(path)).rejects.toThrow(NoPeditError)
    await expect(files.acquire(path)).rejects.toThrow(NoPeditError)
    expect(calls).toBe(2)
  })

  it('rejects a relative path and surfaces a rejection from the function', async () => {
    const rel = mk(async () => 'pedit')
    await expect(rel.files.acquire(write(rel.dir, 'a.md'))).rejects.toThrow(TypeError)
    const bad = mk(async () => {
      throw new Error('boom')
    })
    await expect(bad.files.acquire(write(bad.dir, 'a.md'))).rejects.toThrow('boom')
  })

  live('bin as a function with pedit', () => {
    it('starts the child with the path it returned, once per file', async () => {
      let calls = 0
      const { dir, files } = mk(async () => {
        calls++
        return BIN as string
      })
      const path = write(dir, 'a.md')
      const a = await files.acquire(path)
      expect(await files.acquire(path)).toBe(a)
      expect(calls).toBe(1)
    })
  })
})
