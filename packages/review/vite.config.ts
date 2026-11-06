import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { CSRAdapter } from '@barefootjs/client/csr-adapter'
import { barefoot } from '@barefootjs/vite'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
// @ts-expect-error: plain JS helper without type declarations
import { thirdPartyLicenses } from '../scripts/third-party-licenses.mjs'
import { memoryStorage } from './memory-storage.ts'

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
  test: {
    // Inlined, so the storage stub above applies to the tests as it does to the build.
    server: { deps: { inline: [/lib0/, /yjs/, /y-protocols/, /y-codemirror/] } },
  },
})
