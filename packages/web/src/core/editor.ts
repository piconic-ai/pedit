import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { isFinalStatus, type RoomStatus } from '@pedit/protocol'
import { basicSetup } from 'codemirror'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { commentMarks } from './commentmarks.ts'
import { textTarget } from './comments.ts'
import type { FileSet, OpenFile } from './files.ts'
import { lockedUndo } from './lockedundo.ts'
import type { Room } from './open-room.ts'
import { imagePaste, textAnchor } from './paste.ts'
import { Store } from './store.ts'

/** What stops typing: read links, and the room while nobody keeps the edits. */
export const readOnly: Extension = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

/**
 * What the page adds to a file's editor. `before` goes ahead of the basic
 * setup (the Vim keymap must see keys first), `after` follows it (language,
 * theme, font). `from` is the state being replaced when the file switches, so
 * a compartment can keep the value it holds.
 */
export interface EditorExtras {
  before?: Extension[]
  after?: Extension[]
}

export interface TextEditorOptions {
  room: Room
  files: FileSet
  /** Where the editor is drawn. */
  parent: HTMLElement
  /** The document or shadow root the editor lives in; the one `parent` is in by default. */
  root?: Document | ShadowRoot
  extra?: (file: OpenFile, from?: EditorState) => EditorExtras
}

export interface TextEditor {
  view: EditorView
  /** The editor's selection; a new comment on text goes on it. */
  selection: Store<{ from: number; to: number }>
  /** The compartment holding whether the text can be edited. */
  editable: Compartment
  /** Shows another file's text; the compartments keep their values. */
  setFile(file: OpenFile): void
  dispose(): void
}

/**
 * The room's text editor: the file's text shared through Yjs, with this
 * browser's own undo, the comments' marks, image paste, and read-only
 * following the link and the room's status. The page adds what it chooses
 * (`extra`) and reads and switches files through the result.
 */
export function mountTextEditor(opts: TextEditorOptions): TextEditor {
  const { room, files } = opts
  const editable = new Compartment()
  const selection = new Store({ from: 0, to: 0 })

  const extensions = (file: OpenFile, from?: EditorState): Extension[] => {
    const extra = opts.extra?.(file, from) ?? {}
    const held = (c: Compartment, initial: Extension) => (from && c.get(from)) ?? initial
    return [
      ...(extra.before ?? []),
      basicSetup,
      // Undo only this browser's edits, not everyone's.
      Prec.high(keymap.of(lockedUndo(yUndoManagerKeymap, room.fileLocked))),
      ...(extra.after ?? []),
      // From the link and the room as they are now: a page can mount into a
      // room that is already locked or has ended.
      editable.of(held(editable, room.fileLocked() ? readOnly : [])),
      yCollab(file.text, room.awareness, { undoManager: file.undo }),
      commentMarks(files.threads, files.focus),
      EditorView.updateListener.of((u) => {
        const s = u.state.selection.main
        const was = selection.get()
        if (s.from !== was.from || s.to !== was.to) selection.set({ from: s.from, to: s.to })
      }),
      imagePaste({
        blocked: room.noImages,
        // To the file it was added to, and into it, though another
        // file may be on screen by then.
        upload: (blob) => room.attachments.upload(blob, file.id),
        anchor: (pos) => textAnchor(file.text, pos),
        onError: (message) => room.notices.show(message),
      }),
    ]
  }

  const first = files.shown.get()
  const host = opts.parent
  const found = host.getRootNode()
  const view = new EditorView({
    parent: host,
    root:
      opts.root ?? (found instanceof ShadowRoot || found instanceof Document ? found : undefined),
    // yCollab follows later changes only: start from the text as it is.
    doc: first.text.toString(),
    extensions: extensions(first),
  })

  // Nobody edits while the host is away and nothing keeps the edits, and once
  // the room has ended, for good.
  const onStatus = (s: RoomStatus, wasLocked: boolean) => {
    if (isFinalStatus(s)) {
      view.dispatch({ effects: editable.reconfigure(readOnly) })
    } else if (room.writesFile) {
      const away = room.editLocked()
      if (away !== wasLocked) view.dispatch({ effects: editable.reconfigure(away ? readOnly : []) })
    }
  }
  const detach = files.attachEditor({
    textTarget: () => textTarget(selection.get()),
    textRect: () => {
      const c = view.coordsAtPos(view.state.selection.main.to)
      return c ? new DOMRect(c.left, c.top, c.right - c.left, c.bottom - c.top) : null
    },
    onStatus,
  })
  const stop = selection.subscribe(() => files.aim())

  return {
    view,
    selection,
    editable,
    setFile(file) {
      view.setState(
        EditorState.create({
          doc: file.text.toString(),
          extensions: extensions(file, view.state),
        }),
      )
      // setState runs no update listener: the selection is the new file's.
      selection.set({ from: 0, to: 0 })
    },
    dispose() {
      stop()
      detach()
      view.destroy()
    },
  }
}
