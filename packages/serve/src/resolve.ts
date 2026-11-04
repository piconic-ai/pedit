import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { NoPeditError } from './errors.ts'
import { downloadPedit, type Installed, type InstallTestOptions, stateBin } from './install.ts'
import { nativeRealpath } from './paths.ts'

/** The first pedit release with `pedit serve --stdio`: framed streams on the child's stdin and stdout. */
export const MIN_PEDIT_VERSION = '0.5.0'

const UPDATE_HINT =
  'update with Homebrew (brew upgrade pedit), the install script (https://edit.piconic.ai/install.sh; on Windows: irm https://edit.piconic.ai/install.ps1 | iex) or GitHub releases (https://github.com/piconic-ai/pedit/releases)'

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

const WIN = process.platform === 'win32'

/**
 * What Go needs on Windows: os.UserConfigDir (APPDATA), os.UserHomeDir (USERPROFILE), os.TempDir
 * (TMP, TEMP, USERPROFILE), the loader and sockets (SystemRoot, windir), and the drive.
 */
const WINDOWS_VARS = [
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
]

/**
 * The only environment a pedit child gets. CI is passed on so that a child started in CI skips the
 * update check, as pedit does there on its own.
 */
export function peditEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const names = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'CI', ...(WIN ? WINDOWS_VARS : [])]
  for (const k of names) {
    const v = process.env[k]
    if (v !== undefined) env[k] = v
  }
  return env
}

/**
 * The names to try for `pedit` in a directory. On Windows: PATHEXT's `.exe` and `.com` in its order
 * (a script cannot be spawned without a shell), and `.exe` when PATHEXT lists neither.
 */
export function candidateNames(win = WIN, pathext = process.env.PATHEXT): string[] {
  if (!win) return ['pedit']
  const exts = (pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())
  const names = exts.filter((e) => e === '.exe' || e === '.com')
  return (names.length > 0 ? names : ['.exe']).map((e) => `pedit${e}`)
}

async function findOnPath(): Promise<string | undefined> {
  const names = candidateNames()
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {}
    }
  }
  return undefined
}

/** Checks one candidate: a regular file we may trust that prints a new enough `--version`. */
async function inspect(given: string | undefined): Promise<{ bin: string; version: string }> {
  if (given === undefined) throw new NoPeditError('pedit was not found on the PATH')
  if (!isAbsolute(given)) throw new NoPeditError('the pedit binary must be an absolute path')
  let bin: string
  try {
    bin = await nativeRealpath(given)
    const st = await stat(bin)
    if (!st.isFile()) throw new NoPeditError('the pedit binary is not a regular file')
    // Windows has neither uid nor mode bits: the install location's ACL is what protects it.
    if (!WIN) {
      if (st.uid !== process.getuid?.() && st.uid !== 0) {
        throw new NoPeditError('the pedit binary has another owner')
      }
      if (st.mode & 0o022) throw new NoPeditError('the pedit binary is writable by others')
    }
  } catch (e) {
    if (e instanceof NoPeditError) throw e
    throw new NoPeditError('the pedit binary cannot be used')
  }
  const version = await new Promise<string>((resolve, reject) => {
    execFile(
      bin,
      ['--version'],
      { env: peditEnv(), timeout: 5000, cwd: tmpdir() },
      (err, stdout) =>
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

/**
 * Which pedit binary: `options.bin` (absolute) or `pedit` on the PATH. Config only, never request data.
 * The file must be a regular file owned by this user or root, and not writable by group or others.
 *
 * With `install: true` the app opts in to a download. An explicit `bin` is still used as it is.
 * Otherwise, if the PATH has no usable pedit (missing, untrusted or older than MIN_PEDIT_VERSION),
 * the per-user copy is used (`$XDG_DATA_HOME/pedit/bin/pedit`, `%LOCALAPPDATA%\\pedit\\bin\\pedit.exe`),
 * and only if that is missing or too old is the latest release downloaded there, after the checks
 * install.sh makes. A pedit outside that directory is never touched. `installed` says what was
 * downloaded, and whether the build provenance was checked (`verified`) or only the checksum.
 */
export async function resolvePedit(
  options: { bin?: string; install?: boolean; installTest?: InstallTestOptions } = {},
): Promise<{ bin: string; version: string; installed?: Installed }> {
  if (!options.install || options.bin !== undefined)
    return inspect(options.bin ?? (await findOnPath()))
  try {
    return await inspect(await findOnPath())
  } catch (e) {
    if (!(e instanceof NoPeditError)) throw e
  }
  const own = stateBin()
  try {
    return await inspect(own)
  } catch (e) {
    if (!(e instanceof NoPeditError)) throw e
  }
  let installed: Installed
  try {
    installed = await downloadPedit(own, options.installTest)
  } catch (e) {
    // Another app may have installed it meanwhile (on Windows a running .exe cannot be replaced).
    const other = await inspect(own).catch(() => undefined)
    if (other) return other
    throw e
  }
  return { ...(await inspect(own)), installed }
}
