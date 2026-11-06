import type { Prefs } from './core/prefs.ts'

/** The part of localStorage the per-browser preferences use; injectable for tests. */
export type Store = Prefs

/** localStorage, or null where even touching it throws (some private modes). */
export function defaultStore(): Store | null {
  try {
    return localStorage
  } catch {
    return null
  }
}
