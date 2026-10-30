import { render } from '@barefootjs/client/runtime'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  deriveBlobKeys,
  deriveRoomKeys,
  type FileEntry,
  isFinalStatus,
  metaFiles,
  parseFragment,
  RoomClient,
  type RoomKeys,
  type RoomStatus,
} from '@pedit/protocol'
import { basicSetup } from 'codemirror'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { AlwaysLoad, followOtherTabs } from './alwaysload.ts'
import {
  type Appearance,
  applyText,
  loadAppearance,
  pageColors,
  resolveTheme,
  saveAppearance,
} from './appearance.ts'
import { Attachments, hostAttachments, whyNoImages } from './attachments.ts'
import { BoardView } from './board.ts'
import { read as readCanvas, toJSON } from './canvas.ts'
import { CommentDocs } from './commentdocs.ts'
import { commentMarks } from './commentmarks.ts'
import {
  CommentsPanelState,
  CommentsView,
  type CommentTarget,
  followFocus,
  isCommentKey,
  loadCommentsOpen,
  OpenCounts,
  type ShownThread,
  saveCommentsOpen,
  type ThreadList,
} from './comments.ts'
import { copyText } from './copy.ts'
import { delimiterFor } from './csv.ts'
import { keepAlive } from './expiry.ts'
import { avatarFor, fetchIdentity } from './identity.ts'
import { JsonPane } from './jsonpane.ts'
import { resolveLanguage } from './language.ts'
import { ContextMenu, isMac } from './menu.ts'
import { NoticeBoard } from './notice.ts'
import { applyPalette } from './palette.ts'
import { PreviewPane } from './pane.ts'
import { imagePaste, textAnchor } from './paste.ts'
import {
  colorFor,
  colorsByName,
  type Participant,
  parseRoomLocation,
  participants,
  roomSocketUrl,
  sanitizeUser,
  selectionTint,
} from './room.ts'
import { lineWrapping, settingsModel } from './settings-model.ts'
import { COPIED, shareLinks } from './share.ts'
import { Splitter } from './splitter.ts'
import { Store } from './store.ts'
import { describeError, TableErrors, TableView } from './table.ts'
import { fallbackTheme, loadTheme, readerTheme, ThemeSwitcher } from './themes.ts'
import { NARROW_QUERY, type ViewMode, ViewSwitch } from './view.ts'
import { trackViewport } from './viewport.ts'
import { loadVimMode, VimToggle, vimExtension } from './vim.ts'
import './components/Cards.tsx'
import './components/CommentsPanel.tsx'
import './components/EndedBanner.tsx'
import './components/FileTabs.tsx'
import './components/Header.tsx'
import './components/Layout.tsx'
import './components/Notice.tsx'
import type { LayoutParts } from './components/Layout.tsx'
import { lockedUndo } from './lockedundo.ts'
import './style.css'

const NAME_KEY = 'pedit:name'
const DARK_QUERY = '(prefers-color-scheme: dark)'
const app = document.getElementById('app') as HTMLElement

function loadName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY)
  } catch {
    return null
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name)
  } catch {
    // Private mode or storage disabled: ask again next time.
  }
}

function showLanding(): void {
  render(app, 'Landing')
}

function askName(): Promise<string> {
  return new Promise((resolve) => {
    render(app, 'JoinCard', {
      onJoin: (name: string) => {
        saveName(name)
        resolve(name)
      },
    })
  })
}

interface Me {
  name: string
  avatar?: string
}

interface LoadedTheme {
  id: string
  extension: Extension
}

/** Offline or a stale deploy: start on the default theme of the same scheme. */
function loadStartTheme(id: string): Promise<LoadedTheme> {
  return loadTheme(id).then(
    (extension) => ({ id, extension }),
    () => fallbackTheme(id),
  )
}

/** A file of the room this page has opened, with what edits it. */
interface OpenFile {
  /** Its id in the room's list of files; 0 for the room's own doc. */
  id: number
  doc: Y.Doc
  text: Y.Text
  undo: Y.UndoManager
  /** Shared as nodes and edges rather than text. */
  canvas: boolean
  table: TableView
  board: BoardView
  json: JsonPane
  /** Its comments, once the host shares them (#121), and the id of their doc. */
  comments: CommentsView | null
  commentsMeta?: number
}

async function joinRoom(
  id: string,
  key: string,
  me: Me,
  appearance: Appearance,
  theme: LoadedTheme,
): Promise<void> {
  // What the link gives in this room (#122). A browser that cannot check
  // signatures could only show changes nobody checked.
  const link = parseFragment(key)
  if (!link) throw new Error('not a room link')
  let keys: RoomKeys
  try {
    keys = await deriveRoomKeys(link, id)
  } catch {
    render(app, 'UnsupportedBrowser')
    return
  }
  // Editors edit the file; commenters only its comments; readers nothing.
  const writesFile = keys.access === 'edit'
  const writesComments = keys.access !== 'read'
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const awareness = new Awareness(doc)
  // A guest in a background tab renews only once a minute (#193).
  keepAlive(awareness)
  // Before the editor subscribes, so remote cursors never see a hostile colour.
  awareness.on('change', ({ added, updated }: { added: number[]; updated: number[] }) => {
    for (const id of [...added, ...updated]) {
      const state = awareness.getStates().get(id)
      if (state) sanitizeUser(state, id)
    }
  })
  const color = colorFor(doc.clientID)
  awareness.setLocalState({ user: { ...me, color, colorLight: selectionTint(color) } })

  const roomStatus = new Store<RoomStatus>('connecting')
  const fileName = new Store<string | null>(null)
  const people = new Store<readonly Participant[]>([])
  // Each name's colour in the header, for the comments of people in the room.
  const authorColors = new Store<ReadonlyMap<string, string>>(new Map())
  // The relay's time limit in seconds, once it has closed an expired room.
  const timeLimit = new Store<number | undefined>(undefined)
  // The room's files, once the host shares more than one (#113). File 0 is
  // the room's own doc; each other file opened gets a doc of its own.
  const files = new Store<readonly FileEntry[]>([])
  const current = new Store(0)
  // The comments of the files the host keeps them for (#121): which file of
  // the room holds each file's, those on screen, and what they act on.
  const metaOf = new Map<number, number>()
  // The format the host lists each file of the room in: text files and
  // canvases get comments, a canvas's on its nodes.
  const formats = new Map<number, string>()
  const comments = new Store<CommentsView | null>(null)
  const threadsShown = new Store<readonly ShownThread[]>([])
  const commentFocus = new Store<string | null>(null)
  // The list of threads on screen, open or resolved: that of the thread in focus.
  const commentList = new Store<ThreadList>('open')
  followFocus(threadsShown, commentFocus, commentList)
  // The comments of every file, each in its doc, joined as soon as the host
  // lists them: the tabs count the open threads of files not opened yet.
  // Made with the client, before anything can list a file.
  let commentDocs: CommentDocs | undefined
  const openCounts = new OpenCounts((metaId) => commentDocs?.docFor(metaId) ?? null)
  // Whether the file on screen has comments, and whether the panel shows them.
  const commentable = new Store(false)
  // A narrow screen starts with the panel folded, over the text; a wide one
  // as the reader left it, and keeps what the reader chooses.
  const panel = new CommentsPanelState(
    commentFocus,
    !matchMedia(NARROW_QUERY).matches && (loadCommentsOpen() ?? true),
    (open) => {
      if (!isNarrow.get()) saveCommentsOpen(open)
    },
  )
  const selection = new Store({ from: 0, to: 0 })
  // What a new comment goes on: the table's cells in the table view, else
  // the editor's selection.
  const commentTarget = new Store<CommentTarget | null>(null)
  const locked = new Store(!writesComments)
  // The room closes as soon as the host leaves (or was never there).
  let parts: LayoutParts | undefined
  render(app, 'Layout', { onReady: (p: LayoutParts) => (parts = p) })
  if (!parts) throw new Error('the room page did not lay out')
  const { header, banner, main, source, table, canvas } = parts
  render(banner, 'EndedBanner', {
    status: roomStatus,
    timeLimit,
    text: () => (shown.canvas ? toJSON(readCanvas(shown.doc)) : shown.text.toString()),
    onReconnect: () => location.reload(),
  })
  // Filled in once the client exists; nothing is sent before it connects.
  let client: RoomClient | undefined
  // Editors show the relay their own token, which also lets them add images.
  const admission = keys.editAdmission ?? keys.readAdmission
  const blobKeys = await deriveBlobKeys(keys.frameSecret, admission)
  const attachments = new Attachments({
    roomId: id,
    keys: blobKeys,
    // About the file an image was added to, or the one on screen: its
    // directory on the host takes the image.
    send: (a, file = shown.id) =>
      file === 0 ? client?.sendAttachment(a) : client?.sendFileAttachment(file, a),
  })
  const notices = new NoticeBoard()
  render(parts.notice, 'Notice', {
    message: notices.message,
    uploading: attachments.uploading,
    onDismiss: () => notices.dismiss(),
  })
  const narrow = matchMedia(NARROW_QUERY)
  const isNarrow = new Store(narrow.matches)
  // Filled in below; the switch applies its first mode before the editor exists.
  let showView: (mode: ViewMode) => void = (mode) => {
    main.dataset.view = mode
  }
  const view = new ViewSwitch({ narrow: narrow.matches, onApply: (mode) => showView(mode) })
  narrow.addEventListener('change', () => {
    isNarrow.set(narrow.matches)
    view.setNarrow(narrow.matches)
  })
  // The header is drawn once the editor exists, since the settings act on it.

  const vimMode = new Compartment()
  const editable = new Compartment()
  const language = new Compartment()
  const themeMode = new Compartment()
  const wrap = new Compartment()
  const fontMode = new Compartment()
  // Reused so switching back to Markdown does not reparse the document.
  const markdownSupport = markdown()
  const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false)]
  // Nobody edits while the host is away, nor once the room has ended.
  const editLocked = () => {
    const s = roomStatus.get()
    return s === 'waiting' || isFinalStatus(s)
  }
  // Nor does anyone whose link is below edit, ever.
  const fileLocked = () => editLocked() || !writesFile
  const noImages = () =>
    writesFile
      ? whyNoImages(
          roomStatus.get(),
          people.get().some((p) => p.isHost),
          attachments.host,
        )
      : 'This link cannot add images.'
  // One instance for every editor on the page: readerTheme() alternates.
  const reader = readerTheme()
  const undoManager = new Y.UndoManager(text)
  // The editor's extensions for a file's text. Switching files keeps the
  // settings: each compartment takes what it holds in `from`.
  const editorExtensions = (
    fileId: number,
    fileText: Y.Text,
    undo: Y.UndoManager,
    from?: EditorState,
  ): Extension[] => {
    const held = (c: Compartment, initial: Extension) => (from && c.get(from)) ?? initial
    return [
      // The Vim keymap must see keys before basicSetup's.
      vimMode.of(held(vimMode, [])),
      basicSetup,
      // Undo only this browser's edits, not everyone's.
      Prec.high(keymap.of(lockedUndo(yUndoManagerKeymap, fileLocked))),
      language.of(held(language, markdownSupport)),
      themeMode.of(held(themeMode, theme.extension)),
      fontMode.of(held(fontMode, reader)),
      wrap.of(held(wrap, lineWrapping(appearance.wrap))),
      editable.of(held(editable, writesFile ? [] : readOnly)),
      yCollab(fileText, awareness, { undoManager: undo }),
      commentMarks(threadsShown, commentFocus),
      EditorView.updateListener.of((u) => {
        const s = u.state.selection.main
        const was = selection.get()
        if (s.from !== was.from || s.to !== was.to) selection.set({ from: s.from, to: s.to })
      }),
      imagePaste({
        blocked: noImages,
        // To the file it was added to, and into it, though another
        // file may be on screen by then.
        upload: (file) => attachments.upload(file, fileId),
        anchor: (pos) => textAnchor(fileText, pos),
        onError: (message) => notices.show(message),
      }),
    ]
  }
  const editor = new EditorView({
    parent: source,
    extensions: editorExtensions(0, text, undoManager),
  })

  const followEditor = () => {
    if (main.dataset.view === 'split') preview.follow(editor)
  }
  const alwaysLoad = new AlwaysLoad()
  // Another pedit tab remembered or forgot a provider: follow it here too.
  followOtherTabs(alwaysLoad)
  const preview = new PreviewPane(text, {
    onRender: followEditor,
    images: attachments,
    element: parts.preview,
    alwaysLoad,
  })
  attachments.version.subscribe(() => preview.refresh())
  const splitter = new Splitter(main, { onResize: followEditor })
  // Each file's table error; the view shows the one of the file on screen.
  const tableErrors = new TableErrors(0, (error) =>
    view.setTableError(error && describeError(error)),
  )
  const tableFor = (id: number, fileText: Y.Text, undo: Y.UndoManager) => {
    const t = new TableView(fileText, awareness, undo, {
      onError: (error) => tableErrors.report(id, error),
    })
    if (!writesFile) t.readOnly = true
    // The cell selected can come or go with the table, as well as move.
    const follow = () => {
      if (t === shown.table) aim()
    }
    t.selection.subscribe(follow)
    t.shown.subscribe(follow)
    return t
  }
  // Other editors that follow the settings: each canvas's JSON.
  const fontFollowers: { view: EditorView; compartment: Compartment }[] = []
  const themeFollowers: { view: EditorView; compartment: Compartment }[] = []
  // Whose presence is in a file: peers say which file they have open.
  const inFile = (id: number) => (state: Record<string, unknown>) =>
    (typeof state.file === 'number' ? state.file : 0) === id
  // A file's canvas: the board and its JSON, in the editor's theme. Edits go
  // to the host.
  const canvasFor = (id: number, fileDoc: Y.Doc) => {
    const jsonTheme = new Compartment()
    const jsonFont = new Compartment()
    const json = new JsonPane(fileDoc, {
      send: (m) => (id === 0 ? client?.sendCanvas(m) : client?.sendFileCanvas(id, m)),
      extensions: [
        jsonTheme.of(theme.extension),
        jsonFont.of(fontMode.get(editor.state) ?? reader),
      ],
    })
    fontFollowers.push({ view: json.view, compartment: jsonFont })
    themeFollowers.push({ view: json.view, compartment: jsonTheme })
    themes?.follow(json.view, jsonTheme)
    // Its text cards are Markdown as the file's editor and preview have it:
    // the same rendering, images, players, theme and pasting.
    const board = new BoardView(fileDoc, awareness, {
      json,
      here: inFile(id),
      images: attachments,
      alwaysLoad,
      editorExtensions: () => [themeMode.get(editor.state) ?? theme.extension],
      imagePaste: {
        blocked: noImages,
        upload: (file) => attachments.upload(file, id),
        onError: (message) => notices.show(message),
      },
    })
    if (!writesFile) board.readOnly = true
    attachments.version.subscribe(() => board.refreshMarkdown())
    board.selected.subscribe(() => {
      if (board === shown.board) aim()
    })
    return { json, board }
  }
  let themes: ThemeSwitcher | undefined
  const first: OpenFile = {
    id: 0,
    doc,
    text,
    undo: undoManager,
    canvas: false,
    table: tableFor(0, text, undoManager),
    ...canvasFor(0, doc),
    comments: null,
  }
  // The file on screen, and every file opened so far, which stay in sync.
  let shown = first
  const opened = new Map<number, OpenFile>([[0, first]])
  parts.splitter.replaceChildren(splitter.element)
  parts.table.replaceChildren(first.table.element)
  parts.canvas.replaceChildren(first.board.element)
  let following = 0
  editor.scrollDOM.addEventListener('scroll', () => {
    following ||= requestAnimationFrame(() => {
      following = 0
      followEditor()
    })
  })
  showView = (mode) => {
    main.dataset.view = mode
    preview.active = mode === 'split' || mode === 'preview'
    shown.table.active = mode === 'table'
    shown.board.active = mode === 'canvas'
    editor.requestMeasure()
    followEditor()
    aim()
  }
  showView(view.mode)
  // Keep the page above the on-screen keyboard, with the cursor in sight.
  trackViewport(document.documentElement, window.visualViewport, () => {
    editor.requestMeasure()
    if (!editor.hasFocus) return
    editor.dispatch({ effects: EditorView.scrollIntoView(editor.state.selection.main.head) })
  })

  // The links this browser can hand out: its own and the ones below it.
  const shareMenu = new ContextMenu()
  document.body.append(shareMenu.element)

  // Vim's u and Ctrl-r undo in the file on screen.
  const undoShown = {
    undo: () => (fileLocked() ? null : shown.undo.undo()),
    redo: () => (fileLocked() ? null : shown.undo.redo()),
  }
  const vim = new VimToggle(editor, vimMode, () => vimExtension(undoShown))
  themes = new ThemeSwitcher(editor, themeMode, theme.id)
  for (const f of themeFollowers) themes.follow(f.view, f.compartment)
  const settings = settingsModel(
    editor,
    themes,
    wrap,
    vim,
    alwaysLoad,
    appearance,
    fontMode,
    fontFollowers,
  )
  if (loadVimMode()) settings.setVim(true)
  render(header, 'Header', {
    file: fileName,
    status: roomStatus,
    participants: { people, narrow: isNarrow },
    view,
    settings,
    comments: {
      counts: openCounts.counts,
      files,
      current,
      commentable,
      open: panel.open,
      onToggle: () => panel.toggle(),
    },
    access: keys.access,
    onShare: (button: HTMLElement) => {
      const at = button.getBoundingClientRect()
      const links = shareLinks(location.origin, id, keys.fragments, metaOf.size > 0)
      shareMenu.show(
        links.map((l) => ({
          label: l.unavailable ? `${l.label} (${l.unavailable})` : l.label,
          disabled: l.unavailable !== undefined,
          action: async () => {
            notices.show((await copyText(l.url)) ? COPIED[l.access] : 'Could not copy the link.')
          },
        })),
        at.left,
        at.bottom + 4,
      )
    },
  })

  // Nobody edits while the host is away: nobody would save it. Once the room
  // has ended, for good.
  const setStatus = (s: RoomStatus) => {
    const was = roomStatus.get()
    roomStatus.set(s)
    locked.set(editLocked() || !writesComments)
    if (isFinalStatus(s)) {
      editor.dispatch({ effects: editable.reconfigure(readOnly) })
      for (const f of opened.values()) {
        f.board.readOnly = true
        f.table.readOnly = true
      }
    } else if (writesFile && (s === 'waiting') !== (was === 'waiting')) {
      const away = s === 'waiting'
      editor.dispatch({ effects: editable.reconfigure(away ? readOnly : []) })
      for (const f of opened.values()) {
        f.board.paused = away
        f.table.readOnly = away
      }
    }
  }

  // Markdown until the host tells us the file name; other languages load lazily.
  let languageFor: string | undefined
  const applyLanguage = async (fileName: string, canvas: boolean) => {
    const key = `${shown.id}:${canvas}:${fileName}`
    if (key === languageFor) return
    languageFor = key
    if (canvas) {
      view.setKind('canvas')
      return
    }
    const lang = resolveLanguage(fileName)
    const delimiter = delimiterFor(fileName)
    shown.table.setDelimiter(delimiter)
    view.setKind(lang.kind === 'markdown' ? 'markdown' : delimiter ? 'table' : 'plain')
    let support: Extension
    try {
      support =
        lang.kind === 'markdown'
          ? markdownSupport
          : lang.kind === 'plain'
            ? []
            : await lang.description.load()
    } catch {
      // Offline or a stale deploy: keep editing without highlighting.
      support = []
    }
    // Another file or name may have come while the language was loading.
    if (key !== languageFor) return
    editor.dispatch({ effects: language.reconfigure(support) })
  }

  // Names the file on screen, and edits it as its kind.
  const showName = (name: string) => {
    fileName.set(name)
    document.title = `${name} · pedit`
    void applyLanguage(name, shown.canvas)
  }

  // Opens a file of the room, the first time: a doc of its own, kept in sync
  // from then on, and its own undo, table and canvas.
  const openFile = (entry: FileEntry): OpenFile => {
    const known = opened.get(entry.id)
    if (known) return known
    const fileDoc = new Y.Doc()
    const fileText = fileDoc.getText('content')
    const undo = new Y.UndoManager(fileText)
    const f: OpenFile = {
      id: entry.id,
      doc: fileDoc,
      text: fileText,
      undo,
      canvas: entry.format === 'canvas',
      table: tableFor(entry.id, fileText, undo),
      ...canvasFor(entry.id, fileDoc),
      comments: null,
    }
    if (isFinalStatus(roomStatus.get())) {
      f.board.readOnly = true
      f.table.readOnly = true
    } else if (roomStatus.get() === 'waiting') {
      f.board.paused = true
      f.table.readOnly = true
    }
    opened.set(entry.id, f)
    // A comments doc a forged list of files put under this id goes.
    commentDocs?.takeForFile(entry.id)
    client?.addFile(entry.id, fileDoc)
    followComments(f)
    return f
  }

  // Follows the comments of a text file once the host lists them, in a doc
  // whose every update is checked: anyone in the room can send one.
  const followComments = (f: OpenFile) => {
    const metaId = metaOf.get(f.id)
    const format = formats.get(f.id)
    if (f.comments || !getsComments(format)) return
    const metaDoc = metaId === undefined ? null : (commentDocs?.docFor(metaId) ?? null)
    if (!metaDoc) return
    f.commentsMeta = metaId
    const name = () => {
      const user = awareness.getLocalState()?.user as { name?: unknown } | undefined
      return typeof user?.name === 'string' ? user.name : me.name
    }
    f.comments = new CommentsView(metaDoc, f.doc, {
      name,
      locked: () => editLocked() || !writesComments,
      table: f.table.parsed,
      canvas: format === 'canvas',
    })
    if (f === shown) showComments()
  }
  let stopThreads = () => {}
  // Shows the comments of the file on screen, if it has any.
  const showComments = () => {
    stopThreads()
    const c = shown.comments
    comments.set(c)
    commentable.set(c !== null)
    commentFocus.set(null)
    const show = (t: readonly ShownThread[]) => {
      threadsShown.set(t)
      const cells = commentedCells(t)
      if (!sameSet(cells, shown.table.commented.get())) shown.table.commented.set(cells)
      const nodes = new Set(t.flatMap((x) => (!x.resolved && x.node ? [x.node] : [])))
      if (!sameSet(nodes, shown.board.commented.get())) shown.board.commented.set(nodes)
    }
    show(c?.threads.get() ?? [])
    stopThreads = c ? c.threads.subscribe(show) : () => {}
  }
  // Works out what a new comment would go on, when the selection, the view
  // or the file changes. Declared so showView, which runs first, can call it.
  function aim() {
    const next = shown.board.active
      ? nodeTarget(shown.board.selected.get())
      : shown.table.active
        ? cellsTarget(shown.table)
        : textTarget(selection.get())
    if (!sameTarget(next, commentTarget.get())) commentTarget.set(next)
  }
  selection.subscribe(aim)

  // Shows another file of the room. The editor keeps its settings.
  const switchTo = (id: number) => {
    const entry = files.get().find((f) => f.id === id)
    if (!entry || id === shown.id) return
    shown.table.active = false
    shown.board.active = false
    shown = openFile(entry)
    showComments()
    current.set(id)
    awareness.setLocalStateField('file', id)
    editor.setState(
      EditorState.create({
        doc: shown.text.toString(),
        extensions: editorExtensions(shown.id, shown.text, shown.undo, editor.state),
      }),
    )
    // setState runs no update listener: the selection is the new file's.
    selection.set({ from: 0, to: 0 })
    preview.setText(shown.text)
    table.replaceChildren(shown.table.element)
    canvas.replaceChildren(shown.board.element)
    tableErrors.show(id)
    showName(entry.path)
    showView(view.mode)
  }

  const takeManifest = (list: FileEntry[]) => {
    metaOf.clear()
    formats.clear()
    for (const [file, meta] of metaFiles(list)) metaOf.set(file, meta)
    for (const f of list) formats.set(f.id, f.format)
    // Those of a list sent before, forged or not, go: they would take the
    // places of this list's.
    commentDocs?.keepOnly(new Set(metaOf.values()))
    // Every file with comments is counted, opened or not.
    openCounts.follow(new Map([...metaOf].filter(([file]) => getsComments(formats.get(file)))))
    // A file whose comments the list now puts in another doc, or in none,
    // lets go of those it follows.
    for (const f of opened.values()) {
      if (!f.comments || metaOf.get(f.id) === f.commentsMeta) continue
      f.comments.destroy()
      f.comments = null
      if (f === shown) showComments()
    }
    for (const f of opened.values()) followComments(f)
    // A file of a format this version does not know is left out, and so is
    // the metadata of a file, shown with it.
    const known = list.filter((f) => f.format === 'text' || f.format === 'canvas')
    files.set(known)
    const named = known.find((f) => f.id === shown.id)
    if (!named) return
    // The list may come before the host's state, which says so too.
    if (named.format === 'canvas') shown.canvas = true
    showName(named.path)
  }

  const renderPeople = () => {
    const accessOf = (clientId: number) => client?.accessOf(clientId)
    people.set(participants(awareness.getStates(), doc.clientID, accessOf))
    const colors = colorsByName(people.get())
    if (!sameColors(colors, authorColors.get())) authorColors.set(colors)
    attachments.host = hostAttachments(awareness.getStates(), accessOf)
    // Only an editor's state speaks for the host: anyone can say they are.
    const host = [...awareness.getStates()].find(
      ([id, s]) => s.role === 'host' && accessOf(id) === 'edit',
    )?.[1]
    if (host?.format === 'canvas' && !first.canvas) {
      first.canvas = true
      // The list may have named the file already, as text.
      const named = fileName.get()
      if (shown === first && named) showName(named)
    }
    // Keep showing the file name after the host has gone. Once the host
    // lists the room's files, the list names them.
    if (typeof host?.file === 'string' && shown === first && files.get().length === 0) {
      showName(host.file)
    }
  }

  client = new RoomClient({
    url: roomSocketUrl(location, id),
    keys,
    admissionToken: admission,
    doc,
    awareness,
    onStatus: (s) => {
      if (s === 'expired') timeLimit.set(client?.timeLimitSeconds)
      setStatus(s)
      renderPeople()
      if (s === 'connected') {
        attachments.reconnected()
        for (const f of opened.values()) f.json.reconnected()
      }
    },
    onAttachment: (a) => attachments.handle(a),
    onCanvas: (m) => first.json.handle(m),
    onManifest: takeManifest,
    // A peer's state may stay the same while what it may do rises.
    onAccess: renderPeople,
    onFileAttachment: (_, a) => attachments.handle(a),
    onFileCanvas: (fileId, m) => opened.get(fileId)?.json.handle(m),
  })
  commentDocs = new CommentDocs(client)
  render(parts.files, 'FileTabs', { files, current, onOpen: switchTo, counts: openCounts.counts })
  render(parts.comments, 'CommentsPanel', {
    comments,
    target: commentTarget,
    locked,
    focus: commentFocus,
    list: commentList,
    colors: authorColors,
    menu: new ContextMenu(),
    open: panel.open,
    // The title folds the panel on a narrow screen; on a wide one, the header's button does.
    onToggle: () => {
      if (isNarrow.get()) panel.toggle()
    },
    onShow: (t: ShownThread) => {
      if (t.cells && shown.table.active) {
        shown.table.select(t.cells.from)
        return
      }
      if (t.node && shown.board.active) {
        shown.board.selectNode(t.node)
        return
      }
      if (t.from < 0 || t.to > editor.state.doc.length) return
      editor.dispatch({ selection: { anchor: t.from, head: t.to }, scrollIntoView: true })
      editor.focus()
    },
  })
  // Ctrl or ⌘ with Alt and M comments on the selection, as document editors do.
  document.addEventListener('keydown', (e) => {
    if (!isCommentKey(e, isMac()) || !commentable.get()) return
    e.preventDefault()
    commentList.set('open')
    panel.open.set(true)
    parts?.comments.querySelector<HTMLTextAreaElement>('.comments-new textarea')?.focus()
  })
  awareness.on('change', renderPeople)

  setStatus('connecting')
  client.connect()
  renderPeople()
  window.addEventListener('pagehide', () => void client?.destroy())
}

/** The board's selection as a comment's target: one node. */
function nodeTarget(selected: readonly string[]): CommentTarget | null {
  return selected.length === 1 ? { kind: 'node', id: selected[0]! } : null
}

/** The editor's selection as a comment's target: text, if any is selected. */
function textTarget(s: { from: number; to: number }): CommentTarget | null {
  return s.to > s.from ? { kind: 'text', from: s.from, to: s.to } : null
}

/**
 * The table's selection as a comment's target: the cell, or the corners of
 * its row or column. None while editing a cell, or where there is no cell.
 */
function cellsTarget(view: TableView): CommentTarget | null {
  const s = view.selection.get()
  const table = view.table
  if (!s || !table) return null
  const { row, col } = s.at
  if (s.span === 'row') {
    const n = table.rows[row]?.cells.length ?? 0
    return n > 0 ? { kind: 'cells', from: { row, col: 0 }, to: { row, col: n - 1 } } : null
  }
  if (s.span === 'column') {
    const has = (r: number) => table.rows[r]?.cells[col] !== undefined
    let first = 0
    while (first < table.rows.length && !has(first)) first++
    let last = table.rows.length - 1
    while (last > first && !has(last)) last--
    return has(first) ? { kind: 'cells', from: { row: first, col }, to: { row: last, col } } : null
  }
  return table.rows[row]?.cells[col] ? { kind: 'cells', from: s.at, to: s.at } : null
}

/**
 * The cells open threads start on, keyed "row:col", for the table to mark:
 * the first corner of each, as spreadsheets mark a comment, so a thread over
 * the whole table costs one mark.
 */
function commentedCells(threads: readonly ShownThread[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const t of threads) {
    if (!t.resolved && t.cells) keys.add(`${t.cells.from.row}:${t.cells.from.col}`)
  }
  return keys
}

/** Whether two sets hold the same keys. */
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

/** Whether files of a format get comments: text files and canvases. */
function getsComments(format: string | undefined): boolean {
  return format === 'text' || format === 'canvas'
}

/** Whether two maps of names to colours hold the same. */
function sameColors(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** Whether two comment targets are the same. */
function sameTarget(a: CommentTarget | null, b: CommentTarget | null): boolean {
  if (a === null || b === null || a.kind !== b.kind) return a === b
  if (a.kind === 'text' && b.kind === 'text') return a.from === b.from && a.to === b.to
  if (a.kind === 'node' && b.kind === 'node') return a.id === b.id
  if (a.kind !== 'cells' || b.kind !== 'cells') return false
  const same = (x: { row: number; col: number }, y: { row: number; col: number }) =>
    x.row === y.row && x.col === y.col
  return same(a.from, b.from) && same(a.to, b.to)
}

// A file dropped outside the editor would open in place of the page, and
// the room's key in the URL would go with it.
function keepDroppedFiles(): void {
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    if (hasFiles(e)) e.preventDefault()
  })
}

async function start(): Promise<void> {
  // index.html applied the stored values already; this validates and completes them.
  const prefersDark = matchMedia(DARK_QUERY).matches
  const appearance = loadAppearance(undefined, prefersDark)
  // Settings from an earlier version are migrated once, so the OS scheme then no longer matters.
  saveAppearance(appearance)
  applyText(appearance)
  applyPalette(pageColors(appearance))
  if (location.pathname === '/' || location.pathname === '') {
    showLanding()
    return
  }
  const room = parseRoomLocation(location)
  if (!room) {
    render(app, 'IncompleteLink')
    return
  }
  // Fetch the editor theme meanwhile, so the editor paints in it from the start.
  const theme = loadStartTheme(resolveTheme(appearance, prefersDark))
  // Behind Cloudflare Access we already know who you are.
  const identity = await fetchIdentity()
  const me: Me = identity
    ? { name: identity.name, avatar: await avatarFor(identity) }
    : { name: loadName() ?? (await askName()) }
  const loaded = await theme
  // If the theme could not load, the page matches the default theme the editor falls back to.
  applyPalette(pageColors(appearance, loaded.id))
  keepDroppedFiles()
  if (new URLSearchParams(location.search).get('keep') === '1') {
    const { joinKeptText } = await import('./kept-text.ts')
    await joinKeptText(app, room.id, room.key, loaded.extension, appearance, loaded.id)
    return
  }
  await joinRoom(room.id, room.key, me, appearance, loaded)
}

void start()
