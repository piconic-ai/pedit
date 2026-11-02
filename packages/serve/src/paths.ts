import { realpath as realpathCb, realpathSync } from 'node:fs'
import { promisify } from 'node:util'

/** Errors that mean the path itself is bad, not that the native call is unsupported there. */
const PATH_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'])

/**
 * Try `native`; on an error that is not about the path (some Windows volumes, such as RAM disks and
 * some SMB or virtual drives, cannot answer the native call) use `fallback`. The fallback keeps the
 * spelling it is given, so it never folds case; the dev:ino check still guards aliases.
 */
export function withFallback(
  native: (path: string) => string,
  fallback: (path: string) => string,
): (path: string) => string {
  return (path) => {
    try {
      return native(path)
    } catch (e) {
      if (PATH_ERRORS.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      return fallback(path)
    }
  }
}

/** The async variant of withFallback. */
export function withFallbackAsync(
  native: (path: string) => Promise<string>,
  fallback: (path: string) => Promise<string>,
): (path: string) => Promise<string> {
  return async (path) => {
    try {
      return await native(path)
    } catch (e) {
      if (PATH_ERRORS.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      return fallback(path)
    }
  }
}

/**
 * The native realpath: on Windows it asks the open file for its final path, so another casing or
 * an 8.3 short name of a file comes back as the name on disk, and a junction is followed. The JS
 * `fs.promises.realpath` keeps the spelling it was given there. Elsewhere the two agree.
 */
export const nativeRealpath = withFallbackAsync(
  promisify(realpathCb.native) as (path: string) => Promise<string>,
  promisify(realpathCb) as (path: string) => Promise<string>,
)

export const nativeRealpathSync = withFallback(
  (p) => realpathSync.native(p),
  (p) => realpathSync(p),
)
