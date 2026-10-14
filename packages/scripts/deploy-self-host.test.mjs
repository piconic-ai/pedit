import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { deploySelfHost } from './deploy-self-host.mjs'

test('maintainer commands select their config despite the root self-host config', () => {
  const workerPackage = new URL('../worker/package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(workerPackage, 'utf8'))
  const { unstable_readConfig: readConfig } = createRequire(workerPackage)('wrangler')
  for (const name of ['dev', 'deploy', 'cf-typegen', 'deploy:lab', 'preview']) {
    const configArg = pkg.scripts[name].match(/--config\s+(\S+)/)?.[1]
    assert.ok(configArg, `${name} must not rely on Wrangler's config discovery`)
    const configPath = fileURLToPath(new URL(configArg, workerPackage))
    const config = readConfig({
      config: configPath,
      env: name === 'deploy:lab' ? 'lab' : undefined,
    })
    assert.equal(config.configPath, configPath)
    assert.equal(config.name, name === 'deploy:lab' ? 'edit-lab' : 'edit')
    assert.equal(
      config.r2_buckets[0].bucket_name,
      name === 'deploy:lab' ? 'edit-lab-blobs' : 'edit-blobs',
    )
    if (name === 'preview') {
      assert.equal(config.previews.durable_objects.bindings[0].class_name, 'Room')
      assert.equal(config.previews.r2_buckets[0].bucket_name, 'edit-blobs-preview')
    }
  }
})

test('cleanup uses the provisioned bucket after deployment, including jurisdiction', () => {
  const calls = []
  let config = { r2_buckets: [{ binding: 'BLOBS', bucket_name: 'before' }] }
  deploySelfHost({
    run: (args) => {
      calls.push(args)
      if (args.includes('deploy')) {
        config = {
          r2_buckets: [{ binding: 'BLOBS', bucket_name: 'team-images', jurisdiction: 'eu' }],
        }
      }
    },
    readConfig: () => config,
  })
  assert.equal(calls.length, 3)
  const cleanup = calls[2]
  assert.deepEqual(cleanup.slice(4, 10), [
    'r2',
    'bucket',
    'lifecycle',
    'set',
    'team-images',
    '--file',
  ])
  const policy = JSON.parse(readFileSync(cleanup[10], 'utf8'))
  assert.equal(policy.rules.length, 1)
  assert.equal(policy.rules[0].conditions.prefix, 'rooms/')
  assert.equal(policy.rules[0].deleteObjectsTransition.condition.maxAge, 86400)
  assert.ok(cleanup.includes('--force'))
  assert.deepEqual(cleanup.slice(-2), ['--jurisdiction', 'eu'])
  assert.equal(calls[1].at(-1), cleanup[cleanup.indexOf('--config') + 1])
})

test('dry run builds and packages without touching bucket lifecycle', () => {
  const calls = []
  deploySelfHost({
    dryRun: true,
    run: (args) => calls.push(args),
    readConfig: () => assert.fail('dry run must not read provisioned resources'),
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].at(-1), '--dry-run')
})

test('failed build or deployment stops before cleanup', () => {
  for (const failAt of [1, 2]) {
    let calls = 0
    assert.throws(
      () =>
        deploySelfHost({
          run: () => {
            if (++calls === failAt) throw new Error('failed')
          },
          readConfig: () => assert.fail('deployment failed'),
        }),
      /failed/,
    )
    assert.equal(calls, failAt)
  }
})

test('missing attachment binding fails rather than reporting a complete deployment', () => {
  assert.throws(() => deploySelfHost({ run: () => {}, readConfig: () => ({}) }), /BLOBS/)
})

test('button configuration publishes the isolated server without production domains or previews', () => {
  const config = JSON.parse(readFileSync(new URL('../wrangler.json', import.meta.url), 'utf8'))
  assert.equal(config.workers_dev, true)
  assert.equal(config.preview_urls, false)
  assert.equal(config.routes, undefined)
  assert.equal(config.env, undefined)
  assert.equal(config.previews, undefined)
  assert.ok(config.migrations.some((migration) => migration.new_sqlite_classes.includes('Room')))
  for (const path of [config.main, `${config.assets.directory}/index.html`]) {
    assert.ok(!path.startsWith('../'))
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts['deploy:production'], 'node scripts/deploy-production.mjs')
})

test('every deployment counts its rate limits apart', () => {
  // Workers in one account that share a namespace_id share its counters, so
  // a self-hosted relay deployed beside production must not reuse its ids.
  const workerPackage = new URL('../worker/package.json', import.meta.url)
  const { unstable_readConfig: readConfig } = createRequire(workerPackage)('wrangler')
  const maintainer = fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url))
  const selfHost = fileURLToPath(new URL('../wrangler.json', import.meta.url))
  const production = readConfig({ config: maintainer })
  const deployments = {
    production: production.ratelimits,
    previews: production.previews.ratelimits,
    lab: readConfig({ config: maintainer, env: 'lab' }).ratelimits,
    'self-host': readConfig({ config: selfHost }).ratelimits,
  }
  const seen = new Map()
  for (const [deployment, limits] of Object.entries(deployments)) {
    assert.deepEqual(
      limits.map((l) => l.name).sort(),
      ['CONNECTION_LIMIT', 'ROOM_CREATION_LIMIT'],
      deployment,
    )
    for (const { namespace_id: id } of limits) {
      assert.ok(!seen.has(id), `${deployment} reuses namespace ${id} of ${seen.get(id)}`)
      seen.set(id, deployment)
    }
  }
})

test('the public relay ends rooms after 24 hours; self-hosted relays keep the default', () => {
  const workerPackage = new URL('../worker/package.json', import.meta.url)
  const { unstable_readConfig: readConfig } = createRequire(workerPackage)('wrangler')
  const maintainer = fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url))
  const selfHost = fileURLToPath(new URL('../wrangler.json', import.meta.url))
  const production = readConfig({ config: maintainer })
  assert.equal(production.vars.ROOM_MAX_SECONDS, '86400')
  assert.equal(production.previews.vars.ROOM_MAX_SECONDS, '86400')
  assert.equal(readConfig({ config: maintainer, env: 'lab' }).vars.ROOM_MAX_SECONDS, undefined)
  assert.equal(readConfig({ config: selfHost }).vars.ROOM_MAX_SECONDS, undefined)
})
