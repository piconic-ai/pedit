import type { TextEditor } from './core/editor.ts'
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
  pane: Pick<PreviewPane, 'element' | 'active' | 'blocks' | 'onRendered'>
  textEditor: Pick<TextEditor, 'view' | 'onUpdate'>
  files: Pick<FileSet, 'shown' | 'attachPreview'>
}): () => void {
  const { pane, textEditor, files } = opts
  const editor = textEditor.view
  const root = pane.element
  const doc = root.ownerDocument
  let current: { range: Range; from: number; to: number } | null = null

  // Who to tell when the button's place moves though the offsets did not: the
  // preview takes the selection over from the editor, or gives it back.
  const watchers = new Set<() => void>()
  const moved = () => {
    for (const fn of [...watchers]) fn()
  }
  let making = false
  const stopUpdates = textEditor.onUpdate((u) => {
    if (!current) return
    // The editor's own selection, even over the same text: the editor places the button.
    if (u.selectionSet && !making) {
      current = null
      moved()
      return
    }
    // The range follows the edits of others, as the editor's selection does.
    if (!u.docChanged) return
    current.from = u.changes.mapPos(current.from, 1)
    current.to = u.changes.mapPos(current.to, -1)
  })
  // Another file: its text has other places.
  const stopShown = files.shown.subscribe(() => {
    current = null
  })
  const ours = () => {
    const s = editor.state.selection.main
    return current !== null && s.from === current.from && s.to === current.to
  }
  // Drops the editor selection this view made, if it still is the editor's.
  const drop = () => {
    if (!ours()) return
    current = null
    make({ anchor: editor.state.selection.main.head })
    moved()
  }
  const make = (selection: { anchor: number; head?: number }) => {
    making = true
    try {
      editor.dispatch({ selection })
    } finally {
      making = false
    }
  }
  const settle = () => {
    if (!pane.active) return
    const sel = doc.getSelection()
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
    if (!range || !root.contains(range.commonAncestorContainer)) {
      // The selection left the preview (a drag past its edge, Select all, the
      // comments panel): what this view set is no longer what is selected.
      drop()
      return
    }
    const blocks = pane.blocks
    const source = editor.state.doc.toString()
    // The page shows another text than the editor holds: its places are not the
    // editor's. Once it renders again, this runs again.
    if (!blocks || blocks.source !== source) return
    const at = previewSelectionToSource(blocks, range, source)
    if (!at) {
      // Nothing to comment on any more: drop the selection this view made.
      drop()
      return
    }
    // Before the dispatch: the target is worked out, and the button placed, by it.
    current = { range: range.cloneRange(), ...at }
    make({ anchor: at.from, head: at.to })
    moved()
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const onSelection = () => {
    clearTimeout(timer)
    timer = setTimeout(settle, SETTLE_MS)
  }
  doc.addEventListener('selectionchange', onSelection)
  const stopRendered = pane.onRendered(onSelection)

  const stopFiles = files.attachPreview({
    place() {
      if (!current || !ours()) return null
      // A selection that ends at the start of the next block has an empty last rect.
      const last = [...current.range.getClientRects()]
        .reverse()
        .find((r) => r.width > 0 && r.height > 0)
      if (!last) return null
      const clip = root.getBoundingClientRect()
      // In the right padding of the preview, so the button covers no text; on a
      // narrow screen the padding is small and the button sits in the middle of it.
      const pad = Number.parseFloat(doc.defaultView?.getComputedStyle(root).paddingRight ?? '')
      const inset = Number.isFinite(pad) ? Math.min(16, Math.max(8, pad / 2)) : 16
      return { x: clip.left + root.clientWidth - inset, y: (last.top + last.bottom) / 2, clip }
    },
    watch(fn) {
      watchers.add(fn)
      root.addEventListener('scroll', fn)
      const ro = new ResizeObserver(fn)
      ro.observe(root)
      // What the preview draws moves when it renders again.
      const stopRender = pane.onRendered(fn)
      return () => {
        stopRender()
        watchers.delete(fn)
        root.removeEventListener('scroll', fn)
        ro.disconnect()
      }
    },
  })
  return () => {
    clearTimeout(timer)
    doc.removeEventListener('selectionchange', onSelection)
    stopRendered()
    stopUpdates()
    stopShown()
    stopFiles()
  }
}
