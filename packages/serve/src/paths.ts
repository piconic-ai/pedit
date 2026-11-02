import { realpath as realpathCb, realpathSync } from 'node:fs'
import { promisify } from 'node:util'

/**
 * The native realpath: on Windows it asks the open file for its final path, so another casing or
 * an 8.3 short name of a file comes back as the name on disk, and a junction is followed. The JS
 * `fs.promises.realpath` keeps the spelling it was given there. Elsewhere the two agree.
 */
export const nativeRealpath: (path: string) => Promise<string> = promisify(realpathCb.native)

export const nativeRealpathSync: (path: string) => string = realpathSync.native
