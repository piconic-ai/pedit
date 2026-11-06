import type { Plugin } from 'vite'

/**
 * lib0 (inside Yjs) reads `localStorage` when it loads, to look for debug
 * settings. The element must not touch the page's storage, so it gets lib0's
 * own in-memory fallback instead. Shared by the build and the tests.
 */
export function memoryStorage(): Plugin {
  return {
    name: 'lib0-memory-storage',
    enforce: 'pre',
    load(id) {
      if (!/[\\/]lib0[\\/]storage\.js$/.test(id)) return null
      return `const map = new Map()
export const varStorage = { setItem: (k, v) => map.set(k, v), getItem: (k) => map.get(k) }
export const onChange = () => {}
export const offChange = () => {}`
    },
  }
}
