import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { CSRAdapter } from '@barefootjs/client/csr-adapter'
import { barefoot } from '@barefootjs/vite'
import { defineConfig, type Plugin } from 'vite'
// @ts-expect-error: plain JS helper without type declarations
import { thirdPartyLicenses } from '../scripts/third-party-licenses.mjs'

// The bundle inlines third-party code, so ship their licenses next to it.
function licenses(): Plugin {
  return {
    name: 'third-party-licenses',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: thirdPartyLicenses(
          [...this.getModuleIds()],
          'The pedit-review bundle includes the following third-party packages.',
        ),
      })
    },
  }
}

// barefoot() makes every component an entry, which beats `lib.entry` and
// splits the output. The element is one file.
function singleEntry(): Plugin {
  return {
    name: 'single-entry',
    enforce: 'post',
    configResolved(config) {
      config.build.rollupOptions.input = resolve(config.root, 'src/index.ts')
    },
    // barefoot() turns the manifest on and reads it; a one-file bundle ships none.
    closeBundle: {
      order: 'post',
      handler() {
        rmSync(
          resolve(this.environment.config.root, this.environment.config.build.outDir, '.vite'),
          {
            recursive: true,
            force: true,
          },
        )
      },
    },
  }
}

// lib0 (inside Yjs) reads `localStorage` when it loads, to look for debug
// settings. The element must not touch the page's storage, so it gets lib0's
// own in-memory fallback instead.
function memoryStorage(): Plugin {
  return {
    name: 'lib0-memory-storage',
    enforce: 'pre',
    apply: 'build',
    load(id) {
      if (!/[\\/]lib0[\\/]storage\.js$/.test(id)) return null
      return `const map = new Map()
export const varStorage = { setItem: (k, v) => map.set(k, v), getItem: (k) => map.get(k) }
export const onChange = () => {}
export const offChange = () => {}`
    },
  }
}

export default defineConfig({
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1024,
    manifest: false,
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'pedit-review.js' },
    rollupOptions: { output: { codeSplitting: false } },
  },
  plugins: [
    // Components render in the browser only: the server never sees the content.
    barefoot({ adapter: new CSRAdapter(), components: ['../web/src/core/components'] }),
    singleEntry(),
    memoryStorage(),
    licenses(),
  ],
})
