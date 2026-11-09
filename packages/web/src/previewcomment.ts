import { StateEffect } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { FileSet } from './core/files.ts'
import type { PreviewPane } from './pane.ts'
import { previewSelectionToSource } from './previewselect.ts'

/** How long the reader's selection rests before it becomes the editor's. */
const SETTLE_MS = 80

/**
 * Lets the reader comment on a selection made in the Markdown preview. The
 * selection is mapped to the source and becomes the editor's selection, so the
 * text target, the composer and (in split view) the highlight are the editor's
 * own. The editor is neither focused nor scrolled, so the preview, and the
 * selection in it, stay where they are. The button is placed by the preview's
 * selection for as long as the editor's selection is the one made there.
 * Returns how to stop.
 */
export function commentOnPreviewSelection(opts: {
  pane: PreviewPane
  editor: EditorView
  files: FileSet
}): () => void {
  const { pane, editor, files } = opts
  const root = pane.element
  const doc = root.ownerDocument
  let current: { range: Range; from: number; to: number } | null = null

  // The range follows the edits of others, as the editor's selection does.
  editor.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((u) => {
        if (!current || !u.docChanged) return
        current.from = u.changes.mapPos(current.from, 1)
        current.to = u.changes.mapPos(current.to, -1)
      }),
    ),
  })
  const ours = () => {
    const s = editor.state.selection.main
    return current !== null && s.from === current.from && s.to === current.to
  }
  const settle = () => {
    if (!pane.active) return
    const sel = doc.getSelection()
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
    if (!range || !root.contains(range.commonAncestorContainer)) return
    const at = range.collapsed
      ? null
      : previewSelectionToSource(root, range, editor.state.doc.toString())
    if (!at) {
      // Nothing to comment on any more: drop the selection this view made.
      if (ours()) {
        current = null
        editor.dispatch({ selection: { anchor: editor.state.selection.main.head } })
      }
      return
    }
    // Before the dispatch: the target is worked out, and the button placed, by it.
    current = { range: range.cloneRange(), ...at }
    editor.dispatch({ selection: { anchor: at.from, head: at.to } })
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const onSelection = () => {
    clearTimeout(timer)
    timer = setTimeout(settle, SETTLE_MS)
  }
  doc.addEventListener('selectionchange', onSelection)

  const stopFiles = files.attachPreview({
    place() {
      if (!current || !ours()) return null
      // A selection that ends at the start of the next block has an empty last rect.
      const last = [...current.range.getClientRects()]
        .reverse()
        .find((r) => r.width > 0 && r.height > 0)
      if (!last) return null
      const clip = root.getBoundingClientRect()
      // In the right margin of the preview, so the button covers no text.
      return { x: clip.left + root.clientWidth - 16, y: (last.top + last.bottom) / 2, clip }
    },
    watch(fn) {
      root.addEventListener('scroll', fn)
      const ro = new ResizeObserver(fn)
      ro.observe(root)
      // What the preview draws moves when it renders again.
      const stopRender = pane.onRendered(fn)
      return () => {
        stopRender()
        root.removeEventListener('scroll', fn)
        ro.disconnect()
      }
    },
  })
  return () => {
    clearTimeout(timer)
    doc.removeEventListener('selectionchange', onSelection)
    stopFiles()
  }
}
