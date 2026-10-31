import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { deployProduction, parseLifecycleList } from './deploy-production.mjs'

const configPath = fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url))
const config = { r2_buckets: [{ binding: 'BLOBS', bucket_name: 'edit-blobs' }] }

// What wrangler prints, with its colours.
const label = (name) => `\x1b[37m${name}:\x1b[39m`
const rule = (name, enabled, prefix, action) =>
  [
    `${label('name')}    \x1b[90m${name}\x1b[39m`,
    `${label('enabled')} ${enabled}`,
    `${label('prefix')}  ${prefix}`,
    `${label('action')}  ${action}`,
  ].join('\n')
const header = "Listing lifecycle rules for bucket 'edit-blobs'...\n"
const multipart = rule(
  'Default Multipart Abort Rule',
  'Yes',
  '(all prefixes)',
  'Abort incomplete multipart uploads after 7 days',
)
const expire = (action = 'Expire objects after 1 days', enabled = 'Yes', prefix = 'rooms/') =>
  rule('expire-rooms', enabled, prefix, action)
const expireKept = (action = 'Expire objects after 8 days', enabled = 'Yes', prefix = 'kept/') =>
  rule('expire-kept', enabled, prefix, action)
const both = `${header}${multipart}\n\n${expire()}\n\n${expireKept()}`

function setup({
  list = header + "There are no lifecycle rules for bucket 'edit-blobs'.",
  runFails,
  cfg = config,
} = {}) {
  const calls = { run: [], capture: [], warn: [] }
  const deps = {
    readConfig: () => cfg,
    run: (args) => {
      calls.run.push(args)
      if (runFails?.(args)) throw new Error('boom')
    },
    capture: (args) => {
      calls.capture.push(args)
      if (list instanceof Error) throw list
      return list
    },
    warn: (message) => calls.warn.push(message),
  }
  return { calls, deps }
}

const afterWrangler = (args) => args.slice(args.indexOf('wrangler') + 1)

test('a failed deploy fails and touches no lifecycle rules', () => {
  const { calls, deps } = setup({ runFails: () => true })
  assert.throws(() => deployProduction(deps), /boom/)
  assert.equal(calls.capture.length, 0)
  assert.equal(calls.run.length, 1)
})

test('adds both rules when the bucket has none, without set or --force', () => {
  const { calls, deps } = setup()
  deployProduction(deps)
  assert.deepEqual(calls.run[0], ['--filter', '@pedit/worker', 'run', 'deploy'])
  assert.equal(calls.run.length, 3)
  assert.deepEqual(afterWrangler(calls.run[2]), [
    'r2',
    'bucket',
    'lifecycle',
    'add',
    'edit-blobs',
    'expire-kept',
    'kept/',
    '--expire-days',
    '8',
    '--config',
    configPath,
  ])
  assert.deepEqual(afterWrangler(calls.run[1]), [
    'r2',
    'bucket',
    'lifecycle',
    'add',
    'edit-blobs',
    'expire-rooms',
    'rooms/',
    '--expire-days',
    '1',
    '--config',
    configPath,
  ])
  assert.deepEqual(afterWrangler(calls.capture[0]), [
    'r2',
    'bucket',
    'lifecycle',
    'list',
    'edit-blobs',
    '--config',
    configPath,
  ])
  const all = JSON.stringify([...calls.run, ...calls.capture])
  assert.ok(!all.includes('"set"') && !all.includes('--force'))
  assert.deepEqual(calls.warn, [])
})

test('adds the rules beside the default multipart rule', () => {
  const { calls, deps } = setup({ list: `${header}${multipart}` })
  deployProduction(deps)
  assert.equal(calls.run.length, 3)
  assert.equal(afterWrangler(calls.run[1])[3], 'add')
  assert.equal(afterWrangler(calls.run[2])[3], 'add')
})

test('adds only the kept rule to a bucket deployed before kept rooms', () => {
  const { calls, deps } = setup({ list: `${header}${multipart}\n\n${expire()}` })
  deployProduction(deps)
  assert.equal(calls.run.length, 2)
  assert.equal(afterWrangler(calls.run[1])[5], 'expire-kept')
  assert.deepEqual(calls.warn, [])
})

test('leaves a bucket that has both rules alone, without a warning', () => {
  const { calls, deps } = setup({ list: both })
  deployProduction(deps)
  assert.equal(calls.run.length, 1)
  assert.deepEqual(calls.warn, [])
})

test('warns about a rule that differs, and leaves it alone', () => {
  for (const list of [
    `${expire('Expire objects after 7 days')}\n\n${expireKept()}`,
    `${expire('Expire objects after 1 days', 'No')}\n\n${expireKept()}`,
    `${expire('Expire objects after 1 days', 'Yes', '(all prefixes)')}\n\n${expireKept()}`,
    `${expire()}\n\n${expireKept('Expire objects after 1 days')}`,
  ]) {
    const { calls, deps } = setup({ list: header + list })
    deployProduction(deps)
    assert.equal(calls.run.length, 1)
    assert.equal(calls.warn.length, 1)
    assert.match(calls.warn[0], /not what was expected/)
  }
})

test('only warns when the rules cannot be listed', () => {
  const { calls, deps } = setup({ list: new Error('pnpm failed (exit 1)') })
  deployProduction(deps)
  assert.equal(calls.run.length, 1)
  assert.match(calls.warn[0], /Worker is deployed.*could not be checked or added.*by hand/)
})

test('only warns when a rule cannot be added', () => {
  const { calls, deps } = setup({ runFails: (args) => args.includes('add') })
  deployProduction(deps)
  assert.equal(calls.warn.length, 1)
  assert.match(calls.warn[0], /"expire-rooms".*could not be checked or added: boom/)
})

test('adds nothing when it cannot read the listing', () => {
  const { calls, deps } = setup({ list: 'Something else entirely' })
  deployProduction(deps)
  assert.equal(calls.run.length, 1)
  assert.equal(calls.warn.length, 1)
})

test('passes the jurisdiction on', () => {
  const cfg = { r2_buckets: [{ binding: 'BLOBS', bucket_name: 'edit-blobs', jurisdiction: 'eu' }] }
  const { calls, deps } = setup({ cfg })
  deployProduction(deps)
  assert.deepEqual(calls.capture[0].slice(-2), ['--jurisdiction', 'eu'])
  assert.deepEqual(calls.run[1].slice(-2), ['--jurisdiction', 'eu'])
})

test('a config without the bucket fails after the deploy', () => {
  const { deps } = setup({ cfg: {} })
  assert.throws(() => deployProduction(deps), /BLOBS/)
})

test('reads the bucket name from the real config', () => {
  const { unstable_readConfig: readConfig } = createRequire(
    new URL('../worker/package.json', import.meta.url),
  )('wrangler')
  const { calls, deps } = setup()
  deployProduction({ ...deps, readConfig: () => readConfig({ config: configPath }) })
  assert.equal(afterWrangler(calls.capture[0])[3], 'list')
  assert.equal(afterWrangler(calls.capture[0])[4], 'edit-blobs')
})

test('parses wrangler listings', () => {
  assert.deepEqual(parseLifecycleList(`${header}${multipart}\n\n${expire()}`), [
    {
      name: 'Default Multipart Abort Rule',
      enabled: 'Yes',
      prefix: '(all prefixes)',
      action: 'Abort incomplete multipart uploads after 7 days',
    },
    {
      name: 'expire-rooms',
      enabled: 'Yes',
      prefix: 'rooms/',
      action: 'Expire objects after 1 days',
    },
  ])
  assert.deepEqual(parseLifecycleList("There are no lifecycle rules for bucket 'x'."), [])
  assert.throws(() => parseLifecycleList(''), /could not read/)
})
