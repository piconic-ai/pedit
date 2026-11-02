import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { NoPeditError } from './errors.ts'

/** The first pedit release with `pedit serve --stdio`: framed streams on the child's stdin and stdout. */
export const MIN_PEDIT_VERSION = '0.5.0'

const UPDATE_HINT =
  'update with Homebrew (brew upgrade pedit), the install script (https://edit.piconic.ai/install.sh) or GitHub releases (https://github.com/piconic-ai/pedit/releases)'

/**
 * True when `output` (what `pedit --version` prints) is at least MIN_PEDIT_VERSION. A source build
 * prints `dev` or a Go pseudo-version such as `v0.3.1-0.20261031060942-98b75f74184d`; its base
 * says nothing about the commit, so those are accepted and left to the feature checks.
 */
export function peditVersionOk(output: string, min = MIN_PEDIT_VERSION): boolean {
  const v = output.trim().replace(/^pedit\s+/, '')
  if (v === 'dev' || /-(0\.)?\d{14}-[0-9a-f]{12}(\+.*)?$/.test(v)) return true
  const parse = (s: string) => s.replace(/^v/, '').split(/[-+]/)[0]?.split('.').map(Number) ?? []
  const [got, want] = [parse(v), parse(min)]
  if (got.length !== 3 || got.some(Number.isNaN)) return false
  for (let i = 0; i < 3; i++) {
    if (got[i] !== want[i]) return (got[i] ?? 0) > (want[i] ?? 0)
  }
  return !/^v?\d+\.\d+\.\d+-/.test(v) // 0.5.0-rc1 is older than 0.5.0
}

/** The only environment a pedit child gets. */
export function peditEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR']) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

async function findOnPath(): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, 'pedit')
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

/**
 * Which pedit binary: `options.bin` (absolute) or `pedit` on the PATH. Config only, never request data.
 * The file must be a regular file owned by this user or root, and not writable by group or others.
 */
export async function resolvePedit(
  options: { bin?: string } = {},
): Promise<{ bin: string; version: string }> {
  if (process.platform === 'win32') throw new Error('@pedit/serve does not support Windows')
  const given = options.bin ?? (await findOnPath())
  if (given === undefined) throw new NoPeditError('pedit was not found on the PATH')
  if (!isAbsolute(given)) throw new NoPeditError('the pedit binary must be an absolute path')
  let bin: string
  try {
    bin = await realpath(given)
    const st = await stat(bin)
    if (!st.isFile()) throw new NoPeditError('the pedit binary is not a regular file')
    if (st.uid !== process.getuid?.() && st.uid !== 0) {
      throw new NoPeditError('the pedit binary has another owner')
    }
    if (st.mode & 0o022) throw new NoPeditError('the pedit binary is writable by others')
  } catch (e) {
    if (e instanceof NoPeditError) throw e
    throw new NoPeditError('the pedit binary cannot be used')
  }
  const version = await new Promise<string>((resolve, reject) => {
    execFile(bin, ['--version'], { env: peditEnv(), timeout: 5000, cwd: '/' }, (err, stdout) =>
      err ? reject(new NoPeditError('pedit --version failed')) : resolve(stdout.trim()),
    )
  })
  if (!peditVersionOk(version)) {
    throw new NoPeditError(
      `pedit ${version} is too old: @pedit/serve needs ${MIN_PEDIT_VERSION} or later; ${UPDATE_HINT}`,
    )
  }
  return { bin, version }
}
