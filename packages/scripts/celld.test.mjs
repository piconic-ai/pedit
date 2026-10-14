import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const wrangler = createRequire(new URL('../worker/package.json', import.meta.url))('wrangler')
const read = (name) =>
  wrangler.experimental_readRawConfig({ config: resolve(root, name) }).rawConfig
const celld = read('celld.jsonc')
const cloudflare = read('wrangler.json')

test('the celld config only uses keys celld accepts', () => {
  // celld refuses a config with keys it does not support instead of ignoring
  // them (ratelimits, routes, observability, keep_vars, ...).
  const accepted = new Set([
    'name',
    'main',
    'compatibility_date',
    'compatibility_flags',
    'assets',
    'durable_objects',
    'migrations',
    'r2_buckets',
    'vars',
  ])
  for (const key of Object.keys(celld)) {
    assert.ok(accepted.has(key), `celld.jsonc must not carry ${key}`)
  }
})

test('the celld config keeps main and assets inside its directory', () => {
  // celld resolves both against the config's directory and refuses paths
  // that leave it.
  for (const path of [celld.main, celld.assets.directory]) {
    const rel = relative(root, resolve(root, path))
    assert.ok(rel && !rel.startsWith('..'), `${path} must be inside ${root}`)
  }
})

test('the celld config runs the same relay as the Cloudflare config', () => {
  // Both files sit in the same directory, so their paths resolve alike.
  const at = (path) => resolve(root, path)
  assert.equal(at(celld.main), at(cloudflare.main))
  assert.equal(at(celld.assets.directory), at(cloudflare.assets.directory))
  assert.deepEqual(
    { ...celld.assets, directory: undefined },
    { ...cloudflare.assets, directory: undefined },
  )
  assert.equal(celld.compatibility_date, cloudflare.compatibility_date)
  assert.deepEqual(celld.compatibility_flags, cloudflare.compatibility_flags)
  assert.deepEqual(celld.durable_objects, cloudflare.durable_objects)
  assert.deepEqual(celld.migrations, cloudflare.migrations)
  assert.deepEqual(
    celld.r2_buckets.map((b) => b.binding),
    cloudflare.r2_buckets.map((b) => b.binding),
  )
})
