import type { KeyBinding } from '@codemirror/view'

/**
 * Undo and redo keys that do nothing while `locked()`. Yjs undo changes the
 * shared text directly, past the editor's read-only state, so the lock that
 * stops typing while the host is away does not stop it. A locked key is
 * still taken, so the browser's own undo does not run either.
 */
export function lockedUndo(bindings: readonly KeyBinding[], locked: () => boolean): KeyBinding[] {
  return bindings.map((b) => {
    const run = b.run
    return run ? { ...b, run: (view) => locked() || run(view) } : b
  })
}
