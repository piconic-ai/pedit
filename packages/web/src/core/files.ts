import type { CanvasMessage, FileEntry, RoomStatus } from '@pedit/protocol'
import * as Y from 'yjs'
import type { Table } from './anchors.ts'
import {
  CommentsView,
  type CommentTarget,
  followFocus,
  type ShownThread,
  sameTarget,
  type ThreadList,
} from './comments.ts'
import { getsComments, type Room } from './open-room.ts'
import { type Readable, Store } from './store.ts'

/**
 * What a view of a file does for the room's events: a table, a canvas, a
 * JSON pane. A view is made once for each file as it is opened (see
 * FileSet.addView) and every part of it is optional.
 */
export interface FileView {
  /** The room's status changed (or the file was opened); `canWrite` is whether this link edits files. */
  setStatus?(status: RoomStatus, canWrite: boolean): void
  /** The client is connected again. */
  reconnected?(): void
  /** A canvas message came about this file. */
  canvas?(message: CanvasMessage): void
  /** Where threads can sit besides plain text; the first view to give one wins. */
  anchors?: {
    table?: Readable<Table | null>
    nodes?: () => ReadonlyMap<string, string>
  }
  /** The threads the file shows changed, as the view marks them. */
  commented?(threads: readonly ShownThread[]): void
  /**
   * What a new comment would go on while this view is the one on screen, or
   * undefined when it is not, so the next view (or the text) answers.
   */
  target?(): CommentTarget | null | undefined
  /** Where the target is on screen (the viewport's coordinates), for the button that comments on it. */
  targetRect?(): DOMRect | null
  /** The file went off screen. */
  hide?(): void
  dispose?(): void
}

/** A file of the room this page has opened. */
export interface OpenFile {
  /** Its id in the room's list of files; 0 for the room's own doc. */
  id: number
  doc: Y.Doc
  text: Y.Text
  undo: Y.UndoManager
  /** Shared as nodes and edges rather than text. */
  canvas: boolean
  views: FileView[]
  /** Its comments, once the host shares them (#121), and the id of their doc. */
  comments: CommentsView | null
  commentsMeta?: number
  /** For a view to say that what a new comment would go on may have changed. */
  aim(): void
}

export type FileViewFactory = (file: OpenFile) => FileView

/** What the text editor gives the set (see `mountTextEditor`). */
export interface EditorHooks {
  textTarget(): CommentTarget | null
  /** Where the end of the selection is on screen, or null when it is not drawn. */
  textRect?(): DOMRect | null
  onStatus(status: RoomStatus, wasLocked: boolean): void
}

export interface FileSetOptions {
  /** The name comments are signed with when awareness does not say. */
  name: string
  /** What a new comment goes on when no view says: the editor's selection (or `attachEditor`). */
  textTarget?: () => CommentTarget | null
  /** After the files have followed the room's status. */
  onStatus?(status: RoomStatus, wasLocked: boolean): void
  /** After the files have followed a list of files; `known` is the list. */
  onManifest?(known: FileEntry[]): void
}

/**
 * The files of a room this page has opened, each with its own doc, comments
 * and views, and the one on screen. It takes the room's status, canvas,
 * reconnect and manifest hooks and passes each to every file's views.
 * Views are added (`addView`) before the room connects.
 */
export class FileSet {
  /** The file on screen. */
  readonly shown: Store<OpenFile>
  /** The comments of the file on screen, if it has any. */
  readonly comments = new Store<CommentsView | null>(null)
  readonly threads = new Store<readonly ShownThread[]>([])
  /** The thread in focus, and the list it is in: open or resolved. */
  readonly focus = new Store<string | null>(null)
  readonly list = new Store<ThreadList>('open')
  /** Whether the file on screen has comments. */
  readonly commentable = new Store(false)
  /** What a new comment goes on, following the view on screen. */
  readonly target = new Store<CommentTarget | null>(null)

  readonly #room: Room
  readonly #opts: FileSetOptions
  readonly #opened = new Map<number, OpenFile>()
  readonly #factories: FileViewFactory[] = []
  #editor: EditorHooks | undefined
  #stopThreads = () => {}
  #disposed = false
  #started = false

  constructor(room: Room, opts: FileSetOptions) {
    this.#room = room
    this.#opts = opts
    const first = this.#make(0, room.doc, room.text, new Y.UndoManager(room.text), false)
    this.#opened.set(0, first)
    this.shown = new Store(first)
    followFocus(this.threads, this.focus, this.list)
    room.hooks.status = (s, wasLocked) => {
      for (const f of this.#opened.values()) this.#status(f, s)
      this.#editor?.onStatus(s, wasLocked)
      opts.onStatus?.(s, wasLocked)
    }
    room.hooks.manifest = (known) => {
      this.#manifest()
      opts.onManifest?.(known)
    }
    room.hooks.canvas = (fileId, m) => {
      for (const v of this.#opened.get(fileId)?.views ?? []) v.canvas?.(m)
    }
    room.hooks.reconnected = () => {
      for (const f of this.#opened.values()) for (const v of f.views) v.reconnected?.()
    }
  }

  /** Every file opened so far. */
  all(): IterableIterator<OpenFile> {
    return this.#opened.values()
  }

  get(id: number): OpenFile | undefined {
    return this.#opened.get(id)
  }

  /**
   * Adds a view to every file opened and every file to come. Views are added
   * before any file follows its comments (that is, before the room connects):
   * the anchors the comments read come from the views. Throws after.
   */
  addView(factory: FileViewFactory): void {
    if (this.#started) throw new Error('addView: views must be added before comments are followed')
    this.#factories.push(factory)
    for (const f of this.#opened.values()) this.#addTo(f, factory)
  }

  /**
   * Opens a file of the room, the first time: a doc of its own, kept in sync
   * from then on, its own undo, views and comments.
   */
  open(entry: FileEntry): OpenFile {
    const known = this.#opened.get(entry.id)
    if (known) return known
    const doc = new Y.Doc()
    const text = doc.getText('content')
    const f = this.#make(entry.id, doc, text, new Y.UndoManager(text), entry.format === 'canvas')
    for (const factory of this.#factories) this.#addTo(f, factory)
    this.#opened.set(entry.id, f)
    // A comments doc a forged list of files put under this id goes.
    this.#room.commentDocs.takeForFile(entry.id)
    this.#room.client.addFile(entry.id, doc)
    this.#follow(f)
    return f
  }

  /**
   * Puts another file of the room on screen, opening it the first time, and
   * says which file this browser has open. Returns its entry, or null when
   * there is no such file or it is on screen already.
   */
  switchTo(id: number): FileEntry | null {
    const entry = this.#room.files.get().find((f) => f.id === id)
    const was = this.shown.get()
    if (!entry || id === was.id) return null
    for (const v of was.views) v.hide?.()
    this.shown.set(this.open(entry))
    this.#showComments()
    this.#room.current.set(id)
    this.#room.awareness.setLocalStateField('file', id)
    return entry
  }

  /** Lets the text editor answer for the text target and follow the room's status; returns how to let go. */
  attachEditor(hooks: EditorHooks): () => void {
    this.#editor = hooks
    return () => {
      if (this.#editor === hooks) this.#editor = undefined
    }
  }

  /** Works out what a new comment would go on, when the selection, the view or the file changes. */
  aim(): void {
    let next: CommentTarget | null | undefined
    for (const v of this.shown.get().views) {
      next = v.target?.()
      if (next !== undefined) break
    }
    // Only when no view is active: an active view with nothing selected says
    // null, and a comment must not go on the hidden editor's selection then.
    if (next === undefined) next = (this.#editor?.textTarget ?? this.#opts.textTarget)?.() ?? null
    if (!sameTarget(next, this.target.get())) this.target.set(next)
  }

  /** Where the target is on screen, asked of the view that answers for it. */
  targetRect(): DOMRect | null {
    for (const v of this.shown.get().views) {
      if (v.target?.() !== undefined) return v.targetRect?.() ?? null
    }
    return this.#editor?.textRect?.() ?? null
  }

  /** Lets go of every file's comments and views. */
  dispose(): void {
    this.#disposed = true
    this.#stopThreads()
    this.#stopThreads = () => {}
    this.comments.set(null)
    this.commentable.set(false)
    this.target.set(null)
    this.threads.set([])
    this.focus.set(null)
    for (const f of this.#opened.values()) {
      f.comments?.destroy()
      f.comments = null
      for (const v of f.views) v.dispose?.()
    }
  }

  #make(id: number, doc: Y.Doc, text: Y.Text, undo: Y.UndoManager, canvas: boolean): OpenFile {
    const f: OpenFile = {
      id,
      doc,
      text,
      undo,
      canvas,
      views: [],
      comments: null,
      aim: () => {
        if (this.shown.get() === f) this.aim()
      },
    }
    return f
  }

  #addTo(f: OpenFile, factory: FileViewFactory): void {
    const view = factory(f)
    f.views.push(view)
    view.setStatus?.(this.#room.status.get(), this.#room.writesFile)
  }

  #status(f: OpenFile, s: RoomStatus): void {
    for (const v of f.views) v.setStatus?.(s, this.#room.writesFile)
  }

  /** A file whose comments the list now puts in another doc, or in none, lets go of those it follows. */
  #manifest(): void {
    if (this.#disposed) return
    const shown = this.shown.get()
    for (const f of this.#opened.values()) {
      if (!f.comments || this.#room.metaOf.get(f.id) === f.commentsMeta) continue
      f.comments.destroy()
      f.comments = null
      if (f === shown) this.#showComments()
    }
    for (const f of this.#opened.values()) this.#follow(f)
  }

  /**
   * Follows the comments of a text file once the host lists them, in a doc
   * whose every update is checked: anyone in the room can send one.
   */
  #follow(f: OpenFile): void {
    if (this.#disposed) return
    const room = this.#room
    const metaId = room.metaOf.get(f.id)
    const format = room.formats.get(f.id)
    if (f.comments || !getsComments(format)) return
    const metaDoc = metaId === undefined ? null : room.commentDocs.docFor(metaId)
    if (!metaDoc) return
    this.#started = true
    f.commentsMeta = metaId
    const name = () => {
      const user = room.awareness.getLocalState()?.user as { name?: unknown } | undefined
      return typeof user?.name === 'string' ? user.name : this.#opts.name
    }
    const anchor = <K extends 'table' | 'nodes'>(key: K) =>
      f.views.find((v) => v.anchors?.[key])?.anchors?.[key]
    f.comments = new CommentsView(metaDoc, f.doc, {
      name,
      locked: room.commentsLocked,
      anchors: { table: anchor('table'), nodes: format === 'canvas' ? anchor('nodes') : undefined },
    })
    if (f === this.shown.get()) this.#showComments()
  }

  /** Shows the comments of the file on screen, if it has any. */
  #showComments(): void {
    this.#stopThreads()
    const shown = this.shown.get()
    const c = shown.comments
    this.comments.set(c)
    this.commentable.set(c !== null)
    this.focus.set(null)
    const show = (t: readonly ShownThread[]) => {
      this.threads.set(t)
      for (const v of shown.views) v.commented?.(t)
    }
    show(c?.threads.get() ?? [])
    this.#stopThreads = c ? c.threads.subscribe(show) : () => {}
  }
}
