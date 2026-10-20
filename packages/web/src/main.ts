import { render } from '@barefootjs/client/runtime'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  deriveBlobKeys,
  type FileEntry,
  importKey,
  isFinalStatus,
  RoomClient,
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
  fontSizeRange,
  LINE_HEIGHT,
  loadAppearance,
  pageColors,
  resolveTheme,
  saveAppearance,
} from './appearance.ts'
import { Attachments, hostAttachments, whyNoImages } from './attachments.ts'
import { BoardView } from './board.ts'
import { read as readCanvas, toJSON } from './canvas.ts'
import { delimiterFor } from './csv.ts'
import { avatarFor, fetchIdentity } from './identity.ts'
import { JsonPane } from './jsonpane.ts'
import { resolveLanguage } from './language.ts'
import { NoticeBoard } from './notice.ts'
import { applyPalette } from './palette.ts'
import { PreviewPane } from './pane.ts'
import { imagePaste, textAnchor } from './paste.ts'
import {
  colorFor,
  type Participant,
  parseRoomLocation,
  participants,
  roomSocketUrl,
  sanitizeUser,
  selectionTint,
} from './room.ts'
import type { SettingsModel } from './settings.ts'
import { Splitter } from './splitter.ts'
import { Store } from './store.ts'
import { describeError, TableErrors, TableView } from './table.ts'
import { fallbackTheme, loadTheme, readerTheme, THEMES, ThemeSwitcher } from './themes.ts'
import { NARROW_QUERY, type ViewMode, ViewSwitch } from './view.ts'
import { trackViewport } from './viewport.ts'
import { loadVimMode, VimToggle, vimExtension } from './vim.ts'
import './components/Cards.tsx'
import './components/EndedBanner.tsx'
import './components/FileTabs.tsx'
import './components/Header.tsx'
import './components/Layout.tsx'
import './components/Notice.tsx'
import type { LayoutParts } from './components/Layout.tsx'
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

function lineWrapping(on: boolean): Extension {
  return on ? EditorView.lineWrapping : []
}

/**
 * The settings panel's model: what it shows, and what each control does to
 * the editor and the page. A change that fails puts the control back.
 */
function settingsModel(
  editor: EditorView,
  themes: ThemeSwitcher,
  wrapMode: Compartment,
  vim: VimToggle,
  alwaysLoad: AlwaysLoad,
  initial: Appearance,
  fontMode: Compartment,
  /** Other editors on the page, which take the same reader theme. */
  fontFollowers: readonly { view: EditorView; compartment: Compartment }[] = [],
): SettingsModel {
  const prefersDark = matchMedia(DARK_QUERY)
  let current = initial
  const update = (next: Appearance) => {
    current = next
    saveAppearance(next)
  }
  const fontSizes = fontSizeRange(CSS.supports('-webkit-touch-callout', 'none'))
  const theme = new Store(themes.id)
  const fontSize = new Store(Math.max(fontSizes.min, initial.fontSize))
  const lineHeight = new Store(initial.lineHeight)
  const wrap = new Store(initial.wrap)
  const vimOn = new Store(vim.on)

  const showTheme = async () => {
    const id = resolveTheme(current, prefersDark.matches)
    theme.set(id)
    if (id !== themes.id && !(await themes.set(id))) theme.set(themes.id)
    applyPalette(pageColors(current, themes.id))
  }
  // Until the reader picks a theme, the default one follows the OS. Picking is one-way by
  // design: there is one theme, and no "follow the system" entry to go back to (#30).
  prefersDark.addEventListener('change', () => void showTheme())

  const setText = (next: Appearance) => {
    update(next)
    applyText(current)
    // A CSS variable change alone does not make CodeMirror remeasure line
    // heights, so the gutter would drift out of sync with the text (see
    // readerTheme's doc comment in themes.ts). Every editor gets the same
    // instance, so the next call alternates for all of them.
    const reader = readerTheme()
    editor.dispatch({ effects: fontMode.reconfigure(reader) })
    for (const f of fontFollowers) f.view.dispatch({ effects: f.compartment.reconfigure(reader) })
  }
  return {
    themes: THEMES,
    theme,
    setTheme: (id) => {
      update({ ...current, theme: id })
      void showTheme()
    },
    fontSizeRange: fontSizes,
    fontSize,
    setFontSize: (size) => {
      fontSize.set(size)
      setText({ ...current, fontSize: size })
    },
    lineHeightRange: LINE_HEIGHT,
    lineHeight,
    setLineHeight: (height) => {
      lineHeight.set(height)
      setText({ ...current, lineHeight: height })
    },
    wrap,
    setWrap: (on) => {
      wrap.set(on)
      update({ ...current, wrap: on })
      editor.dispatch({ effects: wrapMode.reconfigure(lineWrapping(on)) })
    },
    vim: vimOn,
    setVim: (on) => {
      vimOn.set(on)
      void vim.set(on).then((ok) => {
        if (!ok) vimOn.set(vim.on)
      })
    },
    alwaysLoad: alwaysLoad.ids,
    forgetAlwaysLoad: (id) => alwaysLoad.forget(id),
  }
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
}

async function joinRoom(
  id: string,
  key: string,
  me: Me,
  appearance: Appearance,
  theme: LoadedTheme,
): Promise<void> {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  const awareness = new Awareness(doc)
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
  // The relay's time limit in seconds, once it has closed an expired room.
  const timeLimit = new Store<number | undefined>(undefined)
  // The room's files, once the host shares more than one (#113). File 0 is
  // the room's own doc; each other file opened gets a doc of its own.
  const files = new Store<readonly FileEntry[]>([])
  const current = new Store(0)
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
  const blobKeys = await deriveBlobKeys(key)
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
      Prec.high(keymap.of(yUndoManagerKeymap)),
      language.of(held(language, markdownSupport)),
      themeMode.of(held(themeMode, theme.extension)),
      fontMode.of(held(fontMode, reader)),
      wrap.of(held(wrap, lineWrapping(appearance.wrap))),
      editable.of(held(editable, [])),
      yCollab(fileText, awareness, { undoManager: undo }),
      imagePaste({
        blocked: () =>
          whyNoImages(
            roomStatus.get(),
            people.get().some((p) => p.isHost),
            attachments.host,
          ),
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
  const tableFor = (id: number, fileText: Y.Text, undo: Y.UndoManager) =>
    new TableView(fileText, awareness, undo, {
      onError: (error) => tableErrors.report(id, error),
    })
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
    const board = new BoardView(fileDoc, awareness, { json, here: inFile(id) })
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
  }
  showView(view.mode)
  // Keep the page above the on-screen keyboard, with the cursor in sight.
  trackViewport(document.documentElement, window.visualViewport, () => {
    editor.requestMeasure()
    if (!editor.hasFocus) return
    editor.dispatch({ effects: EditorView.scrollIntoView(editor.state.selection.main.head) })
  })

  // Vim's u and Ctrl-r undo in the file on screen.
  const undoShown = { undo: () => shown.undo.undo(), redo: () => shown.undo.redo() }
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
    people,
    narrow: isNarrow,
    view,
    settings,
  })

  const setStatus = (s: RoomStatus) => {
    roomStatus.set(s)
    if (isFinalStatus(s)) {
      editor.dispatch({ effects: editable.reconfigure(readOnly) })
      for (const f of opened.values()) f.board.readOnly = true
    }
  }

  // Markdown until the host tells us the file name; other languages load lazily.
  let languageFor: string | undefined
  const applyLanguage = async (fileName: string, canvas: boolean) => {
    const key = `${shown.id}:${fileName}`
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
    }
    if (isFinalStatus(roomStatus.get())) f.board.readOnly = true
    opened.set(entry.id, f)
    client?.addFile(entry.id, fileDoc)
    return f
  }

  // Shows another file of the room. The editor keeps its settings.
  const switchTo = (id: number) => {
    const entry = files.get().find((f) => f.id === id)
    if (!entry || id === shown.id) return
    shown.table.active = false
    shown.board.active = false
    shown = openFile(entry)
    current.set(id)
    awareness.setLocalStateField('file', id)
    editor.setState(
      EditorState.create({
        doc: shown.text.toString(),
        extensions: editorExtensions(shown.id, shown.text, shown.undo, editor.state),
      }),
    )
    preview.setText(shown.text)
    table.replaceChildren(shown.table.element)
    canvas.replaceChildren(shown.board.element)
    tableErrors.show(id)
    showName(entry.path)
    showView(view.mode)
  }

  const takeManifest = (list: FileEntry[]) => {
    // A file of a format this version does not know is left out.
    const known = list.filter((f) => f.format === 'text' || f.format === 'canvas')
    files.set(known)
    const named = known.find((f) => f.id === shown.id)
    if (named) showName(named.path)
  }

  const renderPeople = () => {
    people.set(participants(awareness.getStates(), doc.clientID))
    attachments.host = hostAttachments(awareness.getStates())
    const host = [...awareness.getStates().values()].find((s) => s.role === 'host')
    if (host?.format === 'canvas') first.canvas = true
    // Keep showing the file name after the host has gone. Once the host
    // lists the room's files, the list names them.
    if (typeof host?.file === 'string' && shown === first && files.get().length === 0) {
      showName(host.file)
    }
  }

  client = new RoomClient({
    url: roomSocketUrl(location, id),
    key: await importKey(key),
    admissionToken: blobKeys.admission,
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
    onFileAttachment: (_, a) => attachments.handle(a),
    onFileCanvas: (fileId, m) => opened.get(fileId)?.json.handle(m),
  })
  render(parts.files, 'FileTabs', { files, current, onOpen: switchTo })
  awareness.on('change', renderPeople)

  setStatus('connecting')
  client.connect()
  renderPeople()
  window.addEventListener('pagehide', () => void client?.destroy())
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
  await joinRoom(room.id, room.key, me, appearance, loaded)
}

void start()
