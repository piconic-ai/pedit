import { defineConfig } from 'vite'

// `reviewCSP` on its own: a build of its own, so it never pulls the element.
export default defineConfig({
  build: {
    target: 'es2022',
    emptyOutDir: false,
    manifest: false,
    lib: { entry: 'src/csp.ts', formats: ['es'], fileName: () => 'csp.js' },
  },
})
