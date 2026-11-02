import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { encodeFrame } from '../src/bridge.ts'
import type { Bridge } from '../src/index.ts'

export const BIN = process.env.PEDIT_TEST_BIN

export function tmpRoot(): { dir: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pedit-serve-test-')))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function write(dir: string, name: string, text = 'hello\n'): string {
  const path = join(dir, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  return path
}

export function nextFrame(bridge: Bridge, ms = 5000): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no frame')), ms)
    bridge.onframe = (f) => {
      clearTimeout(t)
      resolve(f)
    }
  })
}

export function closed(bridge: Bridge, ms = 5000): Promise<{ reason: string; code?: number }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('not closed')), ms)
    bridge.onclose = (reason, code) => {
      clearTimeout(t)
      resolve({ reason, code })
    }
  })
}

/** y-protocols sync: messageSync (0), step 1 (0). */
export const isSyncStep1 = (f: Uint8Array) => f[0] === 0 && f[1] === 0
/** messageSync, update, an empty update: what a writer sends and a reader must not. */
export const emptyUpdate = new Uint8Array([0, 2, 2, 0, 0])

/** messageSync, step 1, an empty state vector. */
export const syncStep1 = new Uint8Array([0, 0, 1, 0])

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const octal = (bytes: Uint8Array) =>
  [...bytes].map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('')

/**
 * Shell commands that write one event frame, as pedit does. A `#` in the JSON stands for one
 * character of the shell variable `fromVar`, so a fake can number its starts.
 */
export function printEvent(event: Record<string, unknown>, fromVar?: string): string {
  const bytes = encodeFrame(4, 0, Buffer.from(JSON.stringify(event)))
  const at = fromVar ? bytes.indexOf('#'.charCodeAt(0), 9) : -1
  if (at < 0) return `printf '${octal(bytes)}'`
  return `printf '${octal(bytes.subarray(0, at))}'; printf %s "$${fromVar}"; printf '${octal(bytes.subarray(at + 1))}'`
}
