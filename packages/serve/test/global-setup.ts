import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Build the real pedit once. Without Go, the tests that need it skip.
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pedit-serve-bin-'))
  const bin = join(dir, 'pedit')
  try {
    execFileSync('go', ['build', '-o', bin, './cmd/pedit'], {
      cwd: join(import.meta.dirname, '../../..'),
      stdio: 'pipe',
    })
    chmodSync(bin, 0o755) // a umask of 002 would leave it group-writable, which resolvePedit refuses
    process.env.PEDIT_TEST_BIN = bin
  } catch (e) {
    console.warn(`@pedit/serve: skipping tests that need pedit, go build failed: ${e}`)
  }
  return () => rmSync(dir, { recursive: true, force: true })
}
