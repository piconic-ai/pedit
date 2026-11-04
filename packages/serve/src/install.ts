import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { MAX_BINARY_SIZE, tarGzEntry, zipEntry } from './archive.ts'
import { NoPeditError } from './errors.ts'

const REPO = 'piconic-ai/pedit'
const MAX_ARCHIVE = 64 << 20
const MAX_SMALL = 1 << 20
const TAG = /^v\d+\.\d+\.\d+$/

/** How the install was verified: the checksum alone, or the build provenance as well (needs gh). */
export type Verified = 'checksum' | 'provenance'

/** What a download left behind. */
export interface Installed {
  tag: string
  verified: Verified
}

/** Test-only knobs. Not public API: they may change or go away in any release. */
export interface InstallTestOptions {
  downloadUrl?: string
  apiUrl?: string
  platform?: string
  arch?: string
  /** The GitHub CLI to run (default `gh`, looked up on the PATH). */
  gh?: string
}

/** Where the per-user copy lives: one binary for every app of this user. */
export function stateBin(
  win = process.platform === 'win32',
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const abs = (v: string | undefined) => (v && isAbsolute(v) ? v : undefined)
  if (win) {
    const base = abs(env.LOCALAPPDATA) ?? join(home, 'AppData', 'Local')
    return join(base, 'pedit', 'bin', 'pedit.exe')
  }
  const base = abs(env.XDG_DATA_HOME) ?? join(home, '.local', 'share')
  return join(base, 'pedit', 'bin', 'pedit')
}

/** GET with a size cap: the body is never read past `max` bytes. */
async function get(
  url: string,
  max: number,
  headers: Record<string, string> = {},
): Promise<Buffer> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
  if (!res.ok || !res.body) throw new Error(`could not download ${url}: ${res.status}`)
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    n += c.length
    if (n > max) {
      await res.body.cancel().catch(() => {})
      throw new Error(`${url} is larger than ${max} bytes`)
    }
    chunks.push(Buffer.from(c))
  }
  return Buffer.concat(chunks)
}

function checkChecksum(archive: Buffer, sums: string, name: string): void {
  let want: string | undefined
  for (const line of sums.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length === 2 && f[1]?.replace(/^\*/, '') === name) want = f[0]?.toLowerCase()
  }
  if (!want) throw new Error(`${name} is not listed in checksums.txt`)
  if (createHash('sha256').update(archive).digest('hex') !== want) {
    throw new Error(`checksum mismatch for ${name}`)
  }
}

/** gh and what it needs to find its config; the app's tokens are not passed on purpose. */
function ghEnv(): NodeJS.ProcessEnv {
  const names = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'TMPDIR']
  if (process.platform === 'win32') {
    names.push('USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP')
  }
  const env: NodeJS.ProcessEnv = {}
  for (const k of names) if (process.env[k] !== undefined) env[k] = process.env[k]
  return env
}

/** Runs gh attestation verify. False when gh is not installed; rejects when it refuses. */
function ghVerify(gh: string, args: string[]): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(gh, args, { env: ghEnv(), timeout: 60_000, cwd: tmpdir() }, (err, _out, stderr) => {
      if (!err) return resolve(true)
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return resolve(false)
      reject(new Error(`release provenance verification failed: ${stderr.trim() || err.message}`))
    })
  })
}

/**
 * Downloads the latest pedit release, verifies it as install.sh and `pedit self-update` do
 * (checksum, plus build provenance when gh is installed) and puts the binary at `bin`, atomically.
 * If anything fails, nothing is written there.
 */
export async function downloadPedit(bin: string, t: InstallTestOptions = {}): Promise<Installed> {
  const platform = t.platform ?? process.platform
  const win = platform === 'win32'
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform]
  const arch = { x64: 'amd64', arm64: 'arm64' }[t.arch ?? process.arch]
  if (!os || !arch) {
    throw new NoPeditError(`no pedit release for ${platform}/${t.arch ?? process.arch}`)
  }
  const apiUrl = t.apiUrl ?? 'https://api.github.com'
  const downloadUrl = t.downloadUrl ?? `https://github.com/${REPO}/releases/download`
  const scratch = await mkdtemp(join(tmpdir(), 'pedit-install-')) // 0700
  try {
    const latest = JSON.parse(
      (
        await get(`${apiUrl}/repos/${REPO}/releases/latest`, MAX_SMALL, {
          Accept: 'application/vnd.github+json',
        })
      ).toString(),
    ) as { tag_name?: unknown }
    const tag = latest.tag_name
    if (typeof tag !== 'string' || !TAG.test(tag)) {
      throw new Error(`unexpected release tag ${JSON.stringify(tag)}`)
    }

    const name = `pedit_${tag}_${os}_${arch}${win ? '.zip' : '.tar.gz'}`
    const base = `${downloadUrl}/${tag}/`
    const archive = await get(base + name, MAX_ARCHIVE)
    const sums = (await get(`${base}checksums.txt`, MAX_SMALL)).toString()
    const bundle = await get(`${base}pedit_${tag}.sigstore.json`, MAX_SMALL)
    checkChecksum(archive, sums, name)

    const archivePath = join(scratch, name)
    const bundlePath = join(scratch, 'bundle.json')
    await writeFile(archivePath, archive, { mode: 0o600 })
    await writeFile(bundlePath, bundle, { mode: 0o600 })
    const args = [
      'attestation',
      'verify',
      archivePath,
      '--bundle',
      bundlePath,
      '--repo',
      REPO,
      '--signer-workflow',
      `${REPO}/.github/workflows/release-build.yml`,
      '--deny-self-hosted-runners',
    ]
    try {
      const sha = (
        await get(`${apiUrl}/repos/${REPO}/commits/${tag}`, 256, {
          Accept: 'application/vnd.github.sha',
        })
      )
        .toString()
        .trim()
      if (/^[0-9a-f]{40}$/.test(sha)) args.push('--source-digest', sha, '--signer-digest', sha)
    } catch {} // not pinned to the commit; the check still runs
    const verified: Verified = (await ghVerify(t.gh ?? 'gh', args)) ? 'provenance' : 'checksum'

    const entry = win ? 'pedit.exe' : 'pedit'
    const binary = (win ? zipEntry : tarGzEntry)(archive, entry, MAX_BINARY_SIZE)
    if (!binary) throw new Error(`the archive has no ${entry} at its root`)

    await mkdir(dirname(bin), { recursive: true, mode: 0o700 })
    const stage = join(dirname(bin), `.pedit-install-${randomBytes(6).toString('hex')}`)
    try {
      await writeFile(stage, binary, { mode: 0o755, flag: 'wx' })
      await chmod(stage, 0o755)
      await rename(stage, bin)
    } finally {
      await rm(stage, { force: true })
    }
    return { tag, verified }
  } catch (e) {
    if (e instanceof NoPeditError) throw e
    throw new NoPeditError(`could not install pedit: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
