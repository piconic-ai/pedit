import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

const root = fileURLToPath(new URL('../', import.meta.url))
const workerPackage = new URL('../worker/package.json', import.meta.url)
const configPath = fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url))

// Backstop for the Room's own cleanup (docs/public-relay.md): objects under
// rooms/ are gone a day after they were written.
export const EXPIRE_RULE = { name: 'expire-rooms', prefix: 'rooms/', days: 1 }
const EXPECTED_ACTION = `Expire objects after ${EXPIRE_RULE.days} days`

/**
 * Reads the output of `wrangler r2 bucket lifecycle list`: blocks of
 * `name:` / `enabled:` / `prefix:` / `action:` lines separated by blank lines,
 * or a sentence saying there are no rules. Anything else throws, so that
 * output we do not understand never leads to adding a duplicate rule.
 */
export function parseLifecycleList(output) {
  const text = stripVTControlCharacters(output)
  if (/There are no lifecycle rules/.test(text)) return []
  const rules = []
  for (const block of text.split(/\n\s*\n/)) {
    const rule = {}
    for (const line of block.split('\n')) {
      const match = /^(name|enabled|prefix|action):\s*(.*)$/.exec(line.trim())
      if (match) rule[match[1]] = match[2].trim()
    }
    if (rule.name !== undefined) rules.push(rule)
  }
  if (rules.length === 0) throw new Error('could not read the lifecycle rules from wrangler')
  return rules
}

/**
 * Publishes the Worker, then makes sure the attachment bucket has the
 * "expire-rooms" rule. A failure to publish fails the deploy. A failure to
 * check or add the rule only warns: the Worker is already live, so failing
 * would show a release that did deploy as failed (inviting a re-run or a
 * rollback), and a build token without R2 permission would turn every release
 * red. The rule is the third line of defence, after the cleanup when the host
 * leaves and the Room's hourly alarm; here it only guards against drift.
 *
 * It never runs `lifecycle set` or passes --force: `add` keeps the bucket's
 * other rules, such as Cloudflare's default multipart-abort rule.
 */
export function deployProduction({ run, capture, readConfig, warn }) {
  run(['--filter', '@pedit/worker', 'run', 'deploy'])
  const blob = readConfig().r2_buckets?.find((binding) => binding.binding === 'BLOBS')
  if (!blob?.bucket_name) throw new Error('wrangler.jsonc has no BLOBS bucket name')
  const bucket = blob.bucket_name
  const wrangler = ['--filter', '@pedit/worker', 'exec', 'wrangler', 'r2', 'bucket', 'lifecycle']
  const tail = [
    '--config',
    configPath,
    ...(blob.jurisdiction ? ['--jurisdiction', blob.jurisdiction] : []),
  ]
  try {
    const rules = parseLifecycleList(capture([...wrangler, 'list', bucket, ...tail]))
    const rule = rules.find((r) => r.name === EXPIRE_RULE.name)
    if (!rule) {
      run([
        ...wrangler,
        'add',
        bucket,
        EXPIRE_RULE.name,
        EXPIRE_RULE.prefix,
        '--expire-days',
        String(EXPIRE_RULE.days),
        ...tail,
      ])
    } else if (
      rule.enabled !== 'Yes' ||
      rule.prefix !== EXPIRE_RULE.prefix ||
      rule.action !== EXPECTED_ACTION
    ) {
      warn(
        `WARNING: the "${EXPIRE_RULE.name}" lifecycle rule on ${bucket} is not what was expected (enabled: ${rule.enabled}, prefix: ${rule.prefix}, action: ${rule.action}). It was left as it is; fix it by hand (docs/contributing/deployment.md#attachment-buckets).`,
      )
    }
  } catch (error) {
    warn(
      `WARNING: the Worker is deployed, but the "${EXPIRE_RULE.name}" lifecycle rule on ${bucket} could not be checked or added: ${error.message}. Add it by hand (docs/contributing/deployment.md#attachment-buckets).`,
    )
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const { unstable_readConfig: readConfig } = createRequire(workerPackage)('wrangler')
    deployProduction({
      readConfig: () => readConfig({ config: configPath }),
      run: (args) => {
        const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit' })
        if (result.error) throw result.error
        if (result.status !== 0) throw new Error(`pnpm failed (exit ${result.status})`)
      },
      capture: (args) => {
        const result = spawnSync('pnpm', args, {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
        })
        if (result.error) throw result.error
        if (result.status !== 0) throw new Error(`pnpm failed (exit ${result.status})`)
        return result.stdout
      },
      warn: (message) => console.warn(message),
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
