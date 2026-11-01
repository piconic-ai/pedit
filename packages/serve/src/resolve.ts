import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { NoPeditError } from './errors.ts'

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
  return { bin, version }
}
