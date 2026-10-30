import { CSRAdapter } from '@barefootjs/client/csr-adapter'
import { barefoot } from '@barefootjs/vite'
import { defineConfig, type Plugin } from 'vite'
// @ts-expect-error: plain JS helper without type declarations
import { thirdPartyLicenses } from '../scripts/third-party-licenses.mjs'

// The bundle inlines third-party code, so serve their licenses alongside it.
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
          'The pedit web editor bundles the following third-party packages.',
          [{ header: 'Octicons mark-github (MIT), in src/info.ts', file: 'primer-octicons.txt' }],
        ),
      })
    },
  }
}

export default defineConfig({
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1024,
    // barefoot() adds each component as an entry; the page itself must be named
    // too, or it is left out of the build.
    rollupOptions: { input: { index: 'index.html' } },
  },
  plugins: [
    // Components render in the browser only: the server never sees the
    // content, so there is nothing for it to render.
    barefoot({ adapter: new CSRAdapter(), components: ['src/components'] }),
    licenses(),
  ],
  server: {
    // `pnpm --filter web dev` against a local `wrangler dev` on :8787.
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
})
