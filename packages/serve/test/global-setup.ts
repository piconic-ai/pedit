import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.platform === 'win32' ? '.exe' : ''

// Build the real pedit and the launcher the fake pedits use, once. Without Go, the tests that need
// them skip.
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pedit-serve-bin-'))
  const root = join(import.meta.dirname, '../../..')
  const bin = join(dir, `pedit${EXE}`)
  const fake = join(dir, `fakepedit${EXE}`)
  try {
    execFileSync('go', ['build', '-o', bin, './cmd/pedit'], { cwd: root, stdio: 'pipe' })
    chmodSync(bin, 0o755) // a umask of 002 would leave it group-writable, which resolvePedit refuses
    process.env.PEDIT_TEST_BIN = bin
    execFileSync('go', ['build', '-o', fake, './packages/serve/test/fakepedit'], {
      cwd: root,
      stdio: 'pipe',
    })
    process.env.PEDIT_TEST_FAKE = fake
  } catch (e) {
    console.warn(`@pedit/serve: skipping tests that need pedit, go build failed: ${e}`)
  }
  return () => rmSync(dir, { recursive: true, force: true })
}
