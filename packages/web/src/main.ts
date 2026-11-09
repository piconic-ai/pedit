import { render } from '@barefootjs/client/runtime'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { FileEntry } from '@pedit/protocol'
import { AlwaysLoad, followOtherTabs } from './alwaysload.ts'
import {
  type Appearance,
  applyText,
  loadAppearance,
  pageColors,
  resolveTheme,
  saveAppearance,
} from './appearance.ts'
import { BoardView, setCanvasStatus } from './board.ts'
import { nodeText, read as readCanvas, toJSON } from './canvas.ts'
import { mountBanner, mountNotice } from './core/banner.ts'
import type { CommentTarget, ShownThread } from './core/comments.ts'
import { mountComments } from './core/comments-mount.ts'
import { copyText } from './core/copy.ts'
import { type EditorExtras, mountTextEditor } from './core/editor.ts'
import { FileSet, type FileView, type OpenFile } from './core/files.ts'
import { guardDrops } from './core/guard.ts'
import { ContextMenu } from './core/menu.ts'
import { openRoom, type Room, RoomOpenError } from './core/open-room.ts'
import { Store } from './core/store.ts'
import { delimiterFor } from './csv.ts'
import { avatarFor, fetchIdentity, loadName, saveName } from './identity.ts'
import { infoLinks } from './info.ts'
import { JsonPane } from './jsonpane.ts'
import { resolveLanguage } from './language.ts'
import { applyPalette } from './palette.ts'
import { PreviewPane } from './pane.ts'
import { parseRoomLocation } from './room.ts'
import { cleanName } from './settings.ts'
import { lineWrapping, settingsModel } from './settings-model.ts'
import { COPIED, shareLinks } from './share.ts'
import { Splitter } from './splitter.ts'
import { defaultStore } from './storage.ts'
import { describeError, TableErrors, TableView, tableReadOnly } from './table.ts'
import { fallbackTheme, loadTheme, readerTheme, ThemeSwitcher } from './themes.ts'
import { NARROW_QUERY, type ViewMode, ViewSwitch } from './view.ts'
import { trackViewport } from './viewport.ts'
import { loadVimMode, VimToggle, vimExtension } from './vim.ts'
import './components/Cards.tsx'
import './components/FileTabs.tsx'
import './components/Header.tsx'
import './components/Layout.tsx'
import type { LayoutParts } from './components/Layout.tsx'
import './style.css'

const DARK_QUERY = '(prefers-color-scheme: dark)'
const app = document.getElementById('app') as HTMLElement

function showLanding(): void {
  render(app, 'Landing')
}

function askName(): Promise<string> {
  return new Promise((resolve) => {
    render(app, 'JoinCard', {
      onJoin: (name: string) => {
        saveName(defaultStore(), name)
        resolve(name)
      },
    })
  })
}

interface Me {
  name: string
  avatar?: string
  /** The Cloudflare Access account, kept visible beside a chosen name (#213). */
  account?: string
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

async function joinRoom(
  id: string,
  key: string,
  me: Me,
  appearance: Appearance,
  theme: LoadedTheme,
): Promise<void> {
  let room: Room
  try {
    room = await openRoom({ relay: new URL(location.origin), roomId: id, fragment: key, me })
  } catch (e) {
    if (e instanceof RoomOpenError && e.reason === 'unsupported-browser') {
      render(app, 'UnsupportedBrowser')
      return
    }
    throw e
  }
  const {
    keys,
    writesFile,
    text,
    awareness,
    client,
    attachments,
    notices,
    away,
    fileName,
    people,
    files: roomFiles,
    current,
    metaOf,
    openCounts,
    editLocked,
    fileLocked,
    noImages,
  } = room
  // The room's files, each with its comments (#121) and the views below. A
  // new comment goes on what the view on screen says, else the editor's selection.
  const files = new FileSet(room, {
    name: me.name,
    onManifest: (known) => onManifest(known),
  })
  const { commentable } = files
  const shown = () => files.shown.get()
  // The room closes as soon as the host leaves (or was never there).
  let parts: LayoutParts | undefined
  render(app, 'Layout', { onReady: (p: LayoutParts) => (parts = p) })
  if (!parts) throw new Error('the room page did not lay out')
  const { header, banner, main, source, table, canvas } = parts
  mountBanner(banner, room, {
    text: () => (shown().canvas ? toJSON(readCanvas(shown().doc)) : shown().text.toString()),
    onReconnect: () => location.reload(),
  })
  mountNotice(parts.notice, room)
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
  const language = new Compartment()
  const themeMode = new Compartment()
  const wrap = new Compartment()
  const fontMode = new Compartment()
  // Reused so switching back to Markdown does not reparse the document.
  const markdownSupport = markdown()
  // One instance for every editor on the page: readerTheme() alternates.
  const reader = readerTheme()
  // The page's part of a file's editor. Switching files keeps the settings:
  // each compartment takes what it holds in `from`.
  const pageExtras = (_file: OpenFile, from?: EditorState): EditorExtras => {
    const held = (c: Compartment, initial: Extension) => (from && c.get(from)) ?? initial
    return {
      // The Vim keymap must see keys before basicSetup's.
      before: [vimMode.of(held(vimMode, []))],
      after: [
        language.of(held(language, markdownSupport)),
        themeMode.of(held(themeMode, theme.extension)),
        fontMode.of(held(fontMode, reader)),
        wrap.of(held(wrap, lineWrapping(appearance.wrap))),
      ],
    }
  }
  const textEditor = mountTextEditor({ room, files, parent: source, extra: pageExtras })
  const { view: editor } = textEditor

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
  // What each file shows it with: its table, and its board with the JSON pane.
  const tables = new WeakMap<OpenFile, TableView>()
  const boards = new WeakMap<OpenFile, { board: BoardView; json: JsonPane }>()
  const tableOf = (f: OpenFile) => tables.get(f) as TableView
  const boardOf = (f: OpenFile) => (boards.get(f) as { board: BoardView }).board
  const tableView = (f: OpenFile): FileView => {
    const t = new TableView(f.text, awareness, f.undo, {
      onError: (error) => tableErrors.report(f.id, error),
    })
    if (!writesFile) t.readOnly = true
    tables.set(f, t)
    // The cell selected can come or go with the table, as well as move.
    t.selection.subscribe(f.aim)
    t.shown.subscribe(f.aim)
    return {
      setStatus(s, canWrite) {
        t.readOnly = tableReadOnly(s, canWrite, editLocked())
      },
      anchors: { table: t.parsed },
      commented(threads) {
        const cells = commentedCells(threads)
        if (!sameSet(cells, t.commented.get())) t.commented.set(cells)
      },
      target: () => (t.active ? cellsTarget(t) : undefined),
      targetPlace() {
        // The first cell, so a row or column is marked at its start; at the cell's top-right corner.
        const at = cellsTarget(t)
        const from = at?.kind === 'cells' ? at.from : null
        const cell =
          from && t.element.querySelector(`[data-row="${from.row}"][data-col="${from.col}"]`)
        const clip = t.element.querySelector('.table-scroll')
        if (!cell || !clip) return null
        const r = cell.getBoundingClientRect()
        return { x: r.right, y: r.top, clip: clip.getBoundingClientRect() }
      },
      watchPlace(fn) {
        const ro = new ResizeObserver(fn)
        // The slot is display: contents; its scroller has the box that resizes.
        const box = t.element.querySelector('.table-scroll')
        if (box) ro.observe(box)
        const stop = t.parsed.subscribe(fn)
        return () => {
          ro.disconnect()
          stop()
        }
      },
      hide() {
        t.active = false
      },
    }
  }
  // Other editors that follow the settings: each canvas's JSON.
  const fontFollowers: { view: EditorView; compartment: Compartment }[] = []
  const themeFollowers: { view: EditorView; compartment: Compartment }[] = []
  // Whose presence is in a file: peers say which file they have open.
  const inFile = (id: number) => (state: Record<string, unknown>) =>
    (typeof state.file === 'number' ? state.file : 0) === id
  // A file's canvas: the board and its JSON, in the editor's theme. Edits go
  // to the host.
  const canvasView = (f: OpenFile): FileView => {
    const { id, doc: fileDoc } = f
    const jsonTheme = new Compartment()
    const jsonFont = new Compartment()
    const json = new JsonPane(fileDoc, {
      send: (m) => (id === 0 ? client.sendCanvas(m) : client.sendFileCanvas(id, m)),
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
    boards.set(f, { board, json })
    attachments.version.subscribe(() => board.refreshMarkdown())
    board.selected.subscribe(f.aim)
    return {
      setStatus: (s, canWrite) => setCanvasStatus(board, json, s, canWrite),
      reconnected: () => json.reconnected(),
      canvas: (m) => json.handle(m),
      anchors: {
        nodes: () => new Map(readCanvas(fileDoc).nodes.map((n) => [n.id, nodeText(n)])),
      },
      commented(threads) {
        const nodes = new Set(threads.flatMap((x) => (!x.resolved && x.node ? [x.node] : [])))
        if (!sameSet(nodes, board.commented.get())) board.commented.set(nodes)
      },
      target: () => (board.active ? nodeTarget(board.selected.get()) : undefined),
      targetPlace() {
        const at = nodeTarget(board.selected.get())
        const node =
          at?.kind === 'node' &&
          board.element.querySelector(`.bf-flow__node[data-id="${CSS.escape(at.id)}"]`)
        // The slot is display: contents and has no box; the board inside it does.
        const clip = board.element.querySelector('.canvas-board')
        if (!node || !clip) return null
        const r = node.getBoundingClientRect()
        return { x: r.right, y: r.top, clip: clip.getBoundingClientRect() }
      },
      watchPlace(fn) {
        const ro = new ResizeObserver(fn)
        const box = board.element.querySelector('.canvas-board')
        if (box) ro.observe(box)
        const stop = board.moved.subscribe(fn)
        return () => {
          ro.disconnect()
          stop()
        }
      },
      hide() {
        board.active = false
      },
    }
  }
  let themes: ThemeSwitcher | undefined
  files.addView(tableView)
  files.addView(canvasView)
  const first = shown()
  parts.splitter.replaceChildren(splitter.element)
  parts.table.replaceChildren(tableOf(first).element)
  parts.canvas.replaceChildren(boardOf(first).element)
  let following = 0
  editor.scrollDOM.addEventListener('scroll', () => {
    following ||= requestAnimationFrame(() => {
      following = 0
      followEditor()
    })
  })
  showView = (mode) => {
    main.dataset.view = mode
    files.mode.set(mode)
    preview.active = mode === 'split' || mode === 'preview'
    tableOf(shown()).active = mode === 'table'
    boardOf(shown()).active = mode === 'canvas'
    editor.requestMeasure()
    followEditor()
    files.aim()
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
    undo: () => (fileLocked() ? null : shown().undo.undo()),
    redo: () => (fileLocked() ? null : shown().undo.redo()),
  }
  const vim = new VimToggle(editor, vimMode, () => vimExtension(undoShown))
  themes = new ThemeSwitcher(editor, themeMode, theme.id)
  for (const f of themeFollowers) themes.follow(f.view, f.compartment)
  const myName = new Store(me.name)
  const settings = {
    ...settingsModel(editor, themes, wrap, vim, alwaysLoad, appearance, fontMode, fontFollowers),
    name: myName,
    // Cursors, presence and later comments take it from awareness.
    setName: (typed: string) => {
      const name = cleanName(typed)
      if (!name || name === myName.get()) return
      saveName(defaultStore(), name)
      myName.set(name)
      const user = awareness.getLocalState()?.user as Record<string, unknown> | undefined
      awareness.setLocalStateField('user', { ...user, name })
    },
    ...(me.account && { account: me.account }),
  }
  if (loadVimMode()) settings.setVim(true)
  // A narrow screen starts with the panel folded, over the text; a wide one
  // as the reader left it, and keeps what the reader chooses.
  const commentsPanel = mountComments({
    room,
    files,
    editor,
    parent: parts.comments,
    keyTarget: document,
    floating: {
      host: document.body,
      viewport: () => ({ width: window.innerWidth, height: window.innerHeight }),
      onFrame: (fn) => void requestAnimationFrame(fn),
      onChange(fn) {
        window.addEventListener('scroll', fn, true)
        window.addEventListener('resize', fn)
        return () => {
          window.removeEventListener('scroll', fn, true)
          window.removeEventListener('resize', fn)
        }
      },
    },
    narrow: isNarrow,
    prefs: defaultStore(),
    // The table and the board show a thread on their own cell or node.
    onShow: (t) => {
      if (t.cells && tableOf(shown()).active) {
        tableOf(shown()).select(t.cells.from)
        return true
      }
      if (t.node && boardOf(shown()).active) {
        boardOf(shown()).selectNode(t.node)
        return true
      }
      return false
    },
  })
  render(header, 'Header', {
    file: fileName,
    status: away.header,
    hostAway: away.hostAway,
    participants: { people, narrow: isNarrow },
    view,
    settings,
    comments: {
      counts: openCounts.counts,
      files: roomFiles,
      current,
      commentable,
      open: commentsPanel.open,
      onToggle: () => commentsPanel.toggle(),
    },
    access: keys.access,
    info: infoLinks(location.hostname),
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

  // Markdown until the host tells us the file name; other languages load lazily.
  let languageFor: string | undefined
  const applyLanguage = async (fileName: string, canvas: boolean) => {
    const key = `${shown().id}:${canvas}:${fileName}`
    if (key === languageFor) return
    languageFor = key
    if (canvas) {
      view.setKind('canvas')
      return
    }
    const lang = resolveLanguage(fileName)
    const delimiter = delimiterFor(fileName)
    tableOf(shown()).setDelimiter(delimiter)
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
    void applyLanguage(name, shown().canvas)
  }

  // Shows another file of the room. The editor keeps its settings.
  const switchTo = (id: number) => {
    const entry = files.switchTo(id)
    if (!entry) return
    const f = shown()
    textEditor.setFile(f)
    preview.setText(f.text)
    table.replaceChildren(tableOf(f).element)
    canvas.replaceChildren(boardOf(f).element)
    tableErrors.show(id)
    showName(entry.path)
    showView(view.mode)
  }

  // What the views do once the room has taken a list of files.
  const onManifest = (known: FileEntry[]) => {
    const named = known.find((f) => f.id === shown().id)
    if (!named) return
    // The list may come before the host's state, which says so too.
    if (named.format === 'canvas') shown().canvas = true
    showName(named.path)
  }

  // What the views do once the room has rendered the people.
  const onPeople = (host: Record<string, unknown> | undefined) => {
    if (host?.format === 'canvas' && !first.canvas) {
      first.canvas = true
      // The list may have named the file already, as text.
      const named = fileName.get()
      if (shown() === first && named) showName(named)
    }
    // Keep showing the file name after the host has gone. Once the host
    // lists the room's files, the list names them.
    if (typeof host?.file === 'string' && shown() === first && roomFiles.get().length === 0) {
      showName(host.file)
    }
  }

  render(parts.files, 'FileTabs', {
    files: roomFiles,
    current,
    onOpen: switchTo,
    counts: openCounts.counts,
  })
  room.hooks.people = onPeople
  room.connect()
  // Edits the relay has not logged yet are lost if the page goes.
  window.addEventListener('beforeunload', away.warn)
  window.addEventListener('pagehide', () => {
    files.dispose()
    void room.dispose()
  })
}

/** The board's selection as a comment's target: one node. */
function nodeTarget(selected: readonly string[]): CommentTarget | null {
  return selected.length === 1 ? { kind: 'node', id: selected[0]! } : null
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
  // Behind Cloudflare Access we already know who you are. A name chosen in
  // the settings still wins, so several actors on one account can be told
  // apart; the account stays visible beside it.
  const identity = await fetchIdentity()
  const me: Me = identity
    ? {
        name: loadName(defaultStore()) ?? identity.name,
        account: identity.name,
        avatar: await avatarFor(identity),
      }
    : { name: loadName(defaultStore()) ?? (await askName()) }
  const loaded = await theme
  // If the theme could not load, the page matches the default theme the editor falls back to.
  applyPalette(pageColors(appearance, loaded.id))
  guardDrops(window)
  await joinRoom(room.id, room.key, me, appearance, loaded)
}

void start()
