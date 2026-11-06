import { render } from '@barefootjs/client/runtime'
import type { EditorView } from '@codemirror/view'
import {
  CommentsPanelState,
  isCommentKey,
  loadCommentsOpen,
  type ShownThread,
  saveCommentsOpen,
} from './comments.ts'
import './components/CommentsPanel.tsx'
import type { FileSet } from './files.ts'
import { ContextMenu, isMac } from './menu.ts'
import type { Room } from './open-room.ts'
import type { Prefs } from './prefs.ts'
import type { Readable, Store } from './store.ts'

export interface CommentsMountOptions {
  room: Room
  files: FileSet
  /** The text editor, where a thread's place is shown by default. */
  editor: EditorView
  /** Where the panel is drawn. */
  parent: HTMLElement
  /** Where Ctrl or ⌘ with Alt and M is heard: the page, or the shadow root the panel is in. */
  keyTarget: HTMLElement | Document | ShadowRoot
  /** A narrow screen starts with the panel folded, and does not remember what the reader chooses. */
  narrow: Readable<boolean>
  /** Where the panel's open state is remembered; null for nowhere. */
  prefs: Prefs | null
  /** Shows a thread's place in a view the page adds (a table, a board); true once it has. */
  onShow?: (thread: ShownThread) => boolean
}

export interface CommentsMount {
  open: Store<boolean>
  /** Opens the panel and puts the cursor in the new comment's box. */
  focus(): void
  /** The reader folds or unfolds the panel. */
  toggle(): void
  dispose(): void
}

/** The room's comments panel, with its open state and the shortcut that comments on the selection. */
export function mountComments(opts: CommentsMountOptions): CommentsMount {
  const { room, files, editor, parent, keyTarget, narrow, prefs } = opts
  const panel = new CommentsPanelState(
    files.focus,
    !narrow.get() && (loadCommentsOpen(prefs) ?? true),
    (open) => {
      if (!narrow.get()) saveCommentsOpen(open, prefs)
    },
  )
  render(parent, 'CommentsPanel', {
    comments: files.comments,
    target: files.target,
    locked: room.locked,
    focus: files.focus,
    list: files.list,
    colors: room.authorColors,
    menu: new ContextMenu(),
    open: panel.open,
    // The title folds the panel on a narrow screen; on a wide one, the header's button does.
    onToggle: () => {
      if (narrow.get()) panel.toggle()
    },
    onShow: (t: ShownThread) => {
      if (opts.onShow?.(t)) return
      if (t.from < 0 || t.to > editor.state.doc.length) return
      editor.dispatch({ selection: { anchor: t.from, head: t.to }, scrollIntoView: true })
      editor.focus()
    },
  })
  const focus = () => {
    files.list.set('open')
    panel.open.set(true)
    parent.querySelector<HTMLTextAreaElement>('.comments-new textarea')?.focus()
  }
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent
    if (!isCommentKey(k, isMac()) || !files.commentable.get()) return
    k.preventDefault()
    focus()
  }
  keyTarget.addEventListener('keydown', onKey)
  return {
    open: panel.open,
    focus,
    toggle: () => panel.toggle(),
    dispose() {
      keyTarget.removeEventListener('keydown', onKey)
      parent.replaceChildren()
    },
  }
}
