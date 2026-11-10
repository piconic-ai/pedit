import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tarGzEntry, zipEntry } from '../src/archive.ts'
import { NoPeditError } from '../src/errors.ts'
import { downloadPedit, stateBin } from '../src/install.ts'
import { resolvePedit } from '../src/resolve.ts'
import { tmpRoot } from './helpers.ts'
import { type FakeRelease, fakeRelease, sha256, tarGz, zip } from './release.ts'

const WIN = process.platform === 'win32'
const TAG = 'v0.5.3'
const SHA = 'a'.repeat(40)
const OS = process.platform === 'darwin' ? 'darwin' : 'linux'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64'
const script = (version: string) => `#!/bin/sh\necho "pedit ${version}"\n`
const archiveName = () => `pedit_${TAG}_${OS}_${ARCH}.tar.gz`

let rel: FakeRelease
let dir: string
let cleanup: () => void
let saved: NodeJS.ProcessEnv

beforeEach(async () => {
  saved = { ...process.env }
  rel = await fakeRelease()
  ;({ dir, cleanup } = tmpRoot())
  mkdirSync(join(dir, 'empty'))
  process.env.PATH = join(dir, 'empty')
  process.env.HOME = join(dir, 'home')
  process.env.XDG_DATA_HOME = join(dir, 'data')
})
afterEach(async () => {
  process.env = saved
  await rel.close()
  cleanup()
})

/** Publishes TAG with the given archive; the checksum is right unless `sum` says otherwise. */
function publish(
  archive: Buffer,
  opts: { sum?: string; name?: string; commit?: string | number } = {},
) {
  const name = opts.name ?? archiveName()
  rel.routes.set('/repos/piconic-ai/pedit/releases/latest', JSON.stringify({ tag_name: TAG }))
  rel.routes.set(`/dl/${TAG}/${name}`, archive)
  rel.routes.set(`/dl/${TAG}/checksums.txt`, `${opts.sum ?? sha256(archive)}  ${name}\n`)
  rel.routes.set(`/dl/${TAG}/pedit_${TAG}.sigstore.json`, '{}')
  rel.routes.set(`/repos/piconic-ai/pedit/commits/${TAG}`, opts.commit ?? SHA)
}
// The fixture's platform (darwin or linux, a tar.gz), not the host's, so these run the same on
// Windows; the zip case passes platform: 'win32' itself.
const test = () => ({
  downloadUrl: `${rel.url}/dl`,
  apiUrl: rel.url,
  platform: OS,
  arch: ARCH === 'arm64' ? 'arm64' : 'x64',
})
const good = () =>
  tarGz([
    { name: 'LICENSE', data: 'x' },
    { name: 'pedit', data: script('0.5.3') },
  ])

/** A fake gh on the PATH that logs its arguments and exits with `code`. */
function fakeGh(code = 0): string {
  const bin = join(dir, 'ghbin')
  mkdirSync(bin, { recursive: true })
  const log = join(dir, 'gh.log')
  const body = `#!/bin/sh\nfor a in "$@"; do echo "$a"; done > '${log}'\necho denied >&2\nexit ${code}\n`
  writeFileSync(join(bin, 'gh'), body)
  chmodSync(join(bin, 'gh'), 0o755)
  process.env.PATH = bin
  return log
}
const ghArgs = (log: string) => readFileSync(log, 'utf8').trim().split('\n')

describe('stateBin', () => {
  it('follows XDG_DATA_HOME, then the home directory, and LOCALAPPDATA on Windows', () => {
    expect(stateBin(false, { XDG_DATA_HOME: '/x' }, '/h')).toBe(join('/x', 'pedit', 'bin', 'pedit'))
    expect(stateBin(false, { XDG_DATA_HOME: 'rel' }, '/h')).toBe(
      join('/h', '.local', 'share', 'pedit', 'bin', 'pedit'),
    )
    expect(stateBin(true, { LOCALAPPDATA: '/L' }, '/h')).toBe(
      join('/L', 'pedit', 'bin', 'pedit.exe'),
    )
  })
})

describe('archive readers', () => {
  it('take only the root entry, as a regular file', () => {
    const nested = tarGz([
      { name: 'dir/pedit', data: 'no' },
      { name: '../pedit', data: 'no' },
    ])
    expect(tarGzEntry(nested, 'pedit')).toBeUndefined()
    expect(tarGzEntry(tarGz([{ name: 'pedit', data: 'x', type: '2' }]), 'pedit')).toBeUndefined()
    const ok = tarGz([
      { name: 'a', data: 'x' },
      { name: 'pedit', data: 'yes' },
    ])
    expect(tarGzEntry(ok, 'pedit')?.toString()).toBe('yes')
    const z = zip([
      { name: 'dir/pedit.exe', data: 'no' },
      { name: 'pedit.exe', data: 'yes', deflate: true },
    ])
    expect(zipEntry(z, 'pedit.exe')?.toString()).toBe('yes')
    const bad = zip([
      { name: '../pedit.exe', data: 'no' },
      { name: 'pedit.exe/', data: '' },
    ])
    expect(zipEntry(bad, 'pedit.exe')).toBeUndefined()
  })

  it('enforce the size cap', () => {
    const big = 'x'.repeat(100)
    expect(() => tarGzEntry(tarGz([{ name: 'pedit', data: big }]), 'pedit', 10)).toThrow(/larger/)
    const z = zip([{ name: 'pedit.exe', data: big, deflate: true }])
    expect(() => zipEntry(z, 'pedit.exe', 10)).toThrow(/larger/)
  })
})

describe('downloadPedit', () => {
  const bin = () => join(dir, 'out', 'bin', 'pedit')
  const nothingWritten = () => {
    const d = join(dir, 'out', 'bin')
    expect(existsSync(d) ? readdirSync(d) : []).toEqual([])
  }

  it.skipIf(WIN)('installs with the checksum alone when gh is missing', async () => {
    publish(good())
    expect(await downloadPedit(bin(), test())).toEqual({ tag: TAG, verified: 'checksum' })
    expect(statSync(bin()).mode & 0o777).toBe(0o755)
    expect(statSync(join(dir, 'out', 'bin')).mode & 0o777).toBe(0o700)
    expect(readFileSync(bin(), 'utf8')).toBe(script('0.5.3'))
    expect(readdirSync(join(dir, 'out', 'bin'))).toEqual(['pedit'])
  })

  it.skipIf(WIN)('runs gh pinned to the tag commit and reports provenance', async () => {
    publish(good())
    const log = fakeGh()
    expect(await downloadPedit(bin(), test())).toEqual({ tag: TAG, verified: 'provenance' })
    const a = ghArgs(log)
    expect(a.slice(0, 2)).toEqual(['attestation', 'verify'])
    expect(a[2]).toMatch(/pedit_v0\.5\.3_.*\.tar\.gz$/)
    expect(a[3]).toBe('--bundle')
    expect(a.slice(5)).toEqual([
      '--repo',
      'piconic-ai/pedit',
      '--signer-workflow',
      'piconic-ai/pedit/.github/workflows/release-build.yml',
      '--deny-self-hosted-runners',
      '--source-digest',
      SHA,
      '--signer-digest',
      SHA,
    ])
    expect(existsSync(a[2] as string)).toBe(false) // the scratch files are gone
  })

  it.skipIf(WIN).each([
    ['a failed lookup', 500],
    ['garbage', 'not-a-sha'],
    ['an uppercase sha', 'A'.repeat(40)],
  ])('pins no digest after %s', async (_name, commit) => {
    publish(good(), { commit })
    const log = fakeGh()
    await downloadPedit(bin(), test())
    expect(ghArgs(log)).not.toContain('--source-digest')
    expect(ghArgs(log)).toContain('--deny-self-hosted-runners')
  })

  it.skipIf(WIN)('writes nothing when gh refuses', async () => {
    publish(good())
    fakeGh(1)
    await expect(downloadPedit(bin(), test())).rejects.toThrow(/verification failed: denied/)
    nothingWritten()
  })

  it('writes nothing on a checksum mismatch', async () => {
    publish(good(), { sum: sha256(Buffer.from('other')) })
    await expect(downloadPedit(bin(), test())).rejects.toThrow(/checksum mismatch/)
    nothingWritten()
  })

  it.each(['../pedit', 'dir/pedit', 'pedit.bak'])(
    'refuses an archive with only %s',
    async (name) => {
      publish(tarGz([{ name, data: script('0.5.3') }]))
      await expect(downloadPedit(bin(), test())).rejects.toThrow(/no pedit at its root/)
      nothingWritten()
    },
  )

  it('refuses an oversize archive', async () => {
    publish(Buffer.alloc(64 * 1024 * 1024 + 1))
    await expect(downloadPedit(bin(), test())).rejects.toThrow(/larger than/)
    nothingWritten()
  })

  it('refuses an unsupported platform or architecture before any request', async () => {
    await expect(downloadPedit(bin(), { ...test(), platform: 'freebsd' })).rejects.toThrow(
      NoPeditError,
    )
    await expect(downloadPedit(bin(), { ...test(), arch: 'ia32' })).rejects.toThrow(
      /no pedit release/,
    )
    expect(rel.hits).toEqual([])
  })

  it('refuses a release tag that is not vX.Y.Z', async () => {
    const tag = JSON.stringify({ tag_name: '../v1.0.0' })
    rel.routes.set('/repos/piconic-ai/pedit/releases/latest', tag)
    await expect(downloadPedit(bin(), test())).rejects.toThrow(/unexpected release tag/)
  })

  it('unpacks pedit.exe from the Windows zip', async () => {
    const name = `pedit_${TAG}_windows_${ARCH}.zip`
    const z = zip([
      { name: 'pedit.exe', data: 'MZ', deflate: true },
      { name: 'LICENSE', data: 'x' },
    ])
    publish(z, { name })
    await downloadPedit(bin(), { ...test(), platform: 'win32' })
    expect(readFileSync(bin(), 'utf8')).toBe('MZ')
  })
})

describe.skipIf(WIN)('resolvePedit with install', () => {
  const put = (path: string, version: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, script(version))
    chmodSync(path, 0o755)
    return path
  }
  const opts = () => ({ install: true, installTest: test() })

  it("keeps today's NoPeditError without the opt-in, and downloads nothing", async () => {
    publish(good())
    await expect(resolvePedit()).rejects.toThrow(NoPeditError)
    expect(rel.hits).toEqual([])
  })

  it('uses a new enough pedit on the PATH without a download', async () => {
    const p = put(join(dir, 'pbin', 'pedit'), '0.5.1')
    process.env.PATH = join(dir, 'pbin')
    const r = await resolvePedit(opts())
    expect(r.bin.endsWith(join('pbin', 'pedit'))).toBe(true)
    expect(r.installed).toBeUndefined()
    expect(rel.hits).toEqual([])
    expect(p).toBeTruthy()
  })

  it('uses the per-user copy when the PATH has none', async () => {
    put(stateBin(), '0.5.2')
    const r = await resolvePedit(opts())
    expect(r.version).toBe('pedit 0.5.2')
    expect(r.installed).toBeUndefined()
    expect(rel.hits).toEqual([])
  })

  it('leaves a too old PATH copy alone and downloads to the per-user directory', async () => {
    put(join(dir, 'pbin', 'pedit'), '0.4.0')
    process.env.PATH = join(dir, 'pbin')
    publish(good())
    const r = await resolvePedit(opts())
    expect(r.installed).toEqual({ tag: TAG, verified: 'checksum' })
    expect(r.version).toBe('pedit 0.5.3')
    expect(readFileSync(join(dir, 'pbin', 'pedit'), 'utf8')).toBe(script('0.4.0'))
    expect(readFileSync(stateBin(), 'utf8')).toBe(script('0.5.3'))
  })

  it('replaces a too old per-user copy', async () => {
    put(stateBin(), '0.4.0')
    publish(good())
    expect((await resolvePedit(opts())).version).toBe('pedit 0.5.3')
  })

  it('never falls back from an explicit bin', async () => {
    publish(good())
    const bin = join(dir, 'nope')
    await expect(resolvePedit({ bin, ...opts() })).rejects.toThrow(NoPeditError)
    expect(rel.hits).toEqual([])
  })

  it('leaves a valid binary when two installs race', async () => {
    publish(good())
    const [a, b] = await Promise.all([resolvePedit(opts()), resolvePedit(opts())])
    expect(a.bin).toBe(b.bin)
    expect(b.version).toBe('pedit 0.5.3')
    expect(readdirSync(join(stateBin(), '..'))).toEqual(['pedit'])
  })
})

describe.skipIf(WIN)("resolvePedit with install: 'never'", () => {
  const put = (path: string, version: string) => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, script(version))
    chmodSync(path, 0o755)
  }
  const never = () => ({ install: 'never' as const, installTest: test() })

  it('finds the per-user copy and downloads nothing', async () => {
    put(stateBin(), '0.5.2')
    publish(good())
    const r = await resolvePedit(never())
    expect(r.version).toBe('pedit 0.5.2')
    expect(r.installed).toBeUndefined()
    expect(rel.hits).toEqual([])
  })

  it('prefers the PATH', async () => {
    put(join(dir, 'pbin', 'pedit'), '0.5.1')
    put(stateBin(), '0.5.2')
    process.env.PATH = join(dir, 'pbin')
    expect((await resolvePedit(never())).version).toBe('pedit 0.5.1')
  })

  it('is a NoPeditError with nothing usable, and never goes to the network', async () => {
    publish(good())
    await expect(resolvePedit(never())).rejects.toThrow(NoPeditError)
    put(stateBin(), '0.4.0') // too old: still no download
    await expect(resolvePedit(never())).rejects.toThrow(/too old/)
    expect(rel.hits).toEqual([])
  })

  it('still lets an explicit bin win', async () => {
    put(stateBin(), '0.5.2')
    await expect(resolvePedit({ bin: join(dir, 'nope'), ...never() })).rejects.toThrow(NoPeditError)
  })
})
