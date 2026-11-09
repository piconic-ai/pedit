import type { EditorView } from '@codemirror/view'
import {
  CommentsPanelState,
  loadCommentsOpen,
  type ShownThread,
  saveCommentsOpen,
} from './comments.ts'
import './components/CommentComposer.tsx'
import './components/CommentsPanel.tsx'
import { CommentComposer } from './composer.ts'
import type { FileSet } from './files.ts'
import { ContextMenu } from './menu.ts'
import type { Room } from './open-room.ts'
import type { Prefs } from './prefs.ts'
import { mountComponent } from './render.ts'
import type { Readable, Store } from './store.ts'

/** What the button and composer, drawn over the page by the selection, need of the page they are in. */
export interface Floating {
  /** Where they are added: the page's body, or the shadow root of the panel. */
  host: HTMLElement | ShadowRoot
  /** The size of the viewport they are fixed in. */
  viewport(): { width: number; height: number }
  /** Runs `fn` before the next paint (requestAnimationFrame). */
  onFrame(fn: () => void): void
  /** Calls `fn` when the page scrolls or the viewport resizes; returns how to stop. */
  onChange(fn: () => void): () => void
}

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
  floating: Floating
  /** Shows a thread's place in a view the page adds (a table, a board); true once it has. */
  onShow?: (thread: ShownThread) => boolean
}

export interface CommentsMount {
  open: Store<boolean>
  /** Opens the composer on the selection, or just the panel when there is nothing to comment on. */
  focus(): void
  /** The reader folds or unfolds the panel. */
  toggle(): void
  dispose(): void
}

/** The room's comments panel, with its open state and the shortcut that comments on the selection. */
export function mountComments(opts: CommentsMountOptions): CommentsMount {
  const { room, files, editor, parent, keyTarget, narrow, prefs, floating } = opts
  const panel = new CommentsPanelState(
    files.focus,
    !narrow.get() && (loadCommentsOpen(prefs) ?? true),
    (open) => {
      if (!narrow.get()) saveCommentsOpen(open, prefs)
    },
  )
  // The panel's menu (a thread's More); disposed with it, open or not.
  const menu = new ContextMenu()
  const unmount = mountComponent(parent, 'CommentsPanel', {
    comments: files.comments,
    locked: room.locked,
    focus: files.focus,
    list: files.list,
    colors: room.authorColors,
    menu,
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
  // The composer and its button float over the page, beside the selection.
  const composer = new CommentComposer(
    files,
    room.locked,
    () => {
      files.list.set('open')
      panel.open.set(true)
    },
    floating.viewport,
  )
  const floatHost = parent.ownerDocument.createElement('div')
  floating.host.append(floatHost)
  const unmountComposer = mountComponent(floatHost, 'CommentComposer', {
    button: composer.button,
    composing: composer.composing,
    onOpen: () => composer.open(),
    onSend: (body: string) => composer.send(body),
    onCancel: () => composer.cancel(),
  })
  const focus = () => {
    // Already writing: back to the box.
    const box = floatHost.querySelector<HTMLTextAreaElement>('.comment-compose textarea')
    if (box) return box.focus()
    if (composer.open()) return
    files.list.set('open')
    panel.open.set(true)
  }
  const onKey = (e: Event) => {
    const k = e as KeyboardEvent
    if (!composer.isKey(k) || !files.commentable.get()) return
    k.preventDefault()
    focus()
  }
  // The button follows the selection as the page scrolls or resizes; these
  // are heard only while there is a selection to comment on.
  const place = () => composer.place()
  let stopChanges: (() => void) | null = null
  let pending = false
  // What the views draw settles after their own events: placed a frame later.
  const later = () => {
    if (pending) return
    pending = true
    floating.onFrame(() => {
      pending = false
      place()
    })
  }
  const listen = (on: boolean) => {
    if (on && !stopChanges) {
      const stops = [floating.onChange(place), files.watchPlace(later)]
      stopChanges = () => {
        for (const stop of stops) stop()
      }
    } else if (!on && stopChanges) {
      stopChanges()
      stopChanges = null
    }
  }
  const stopListening = files.target.subscribe((t) => listen(t !== null))
  listen(files.target.get() !== null)
  keyTarget.addEventListener('keydown', onKey)
  return {
    open: panel.open,
    focus,
    toggle: () => panel.toggle(),
    dispose() {
      keyTarget.removeEventListener('keydown', onKey)
      stopListening()
      listen(false)
      composer.dispose()
      unmountComposer()
      floatHost.remove()
      panel.dispose()
      menu.dispose()
      unmount()
    },
  }
}
