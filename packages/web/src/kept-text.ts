import { render } from '@barefootjs/client/runtime'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  deriveBlobKeys,
  deriveRoomKeys,
  type FileEntry,
  metaFiles,
  parseFragment,
} from '@pedit/protocol'
import { KeptTextClient, KeptTextClosedError } from '@pedit/protocol/kept-text'
import { basicSetup } from 'codemirror'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { AlwaysLoad } from './alwaysload.ts'
import { type Appearance, applyText, loadAppearance, resolveTheme } from './appearance.ts'
import { Attachments } from './attachments.ts'
import { commentMarks } from './commentmarks.ts'
import {
  CommentsView,
  type CommentTarget,
  followFocus,
  type ShownThread,
  sameTarget,
  type ThreadList,
  textTarget,
} from './comments.ts'
import type { LayoutParts } from './components/Layout.tsx'
import type { KeptSyncStatus } from './components/RoomStatusIndicator.tsx'
import { PreviewPane } from './pane.ts'
import { imagePaste, textAnchor } from './paste.ts'
import { lineWrapping, settingsModel } from './settings-model.ts'
import { Splitter } from './splitter.ts'
import { readerTheme, ThemeSwitcher } from './themes.ts'
import { NARROW_QUERY, ViewSwitch } from './view.ts'
import { loadVimMode, VimToggle, vimExtension } from './vim.ts'
import './components/Header.tsx'
import './components/FileTabs.tsx'
import './components/KeptTextNotice.tsx'
import './components/CommentsPanel.tsx'
import './components/Notice.tsx'
import { lockedUndo } from './lockedundo.ts'
import { ContextMenu } from './menu.ts'
import { NoticeBoard } from './notice.ts'
import { Store } from './store.ts'

export async function joinKeptText(
  container: HTMLElement,
  id: string,
  key: string,
  theme: Extension,
  appearance: Appearance = loadAppearance(
    undefined,
    matchMedia('(prefers-color-scheme: dark)').matches,
  ),
  themeId = resolveTheme(appearance, matchMedia('(prefers-color-scheme: dark)').matches),
  authorName = 'Guest',
): Promise<void> {
  const link = parseFragment(key)
  if (!link) throw new Error('invalid room link')
  const keys = await deriveRoomKeys(link, id),
    doc = new Y.Doc()
  const status = new Store<KeptSyncStatus>('connecting'),
    file = new Store<string | null>(null),
    files = new Store<readonly FileEntry[]>([]),
    current = new Store(0),
    hostAway = new Store(false),
    deadline = new Store<string | null>(null),
    skipped = new Store(0)
  let parts: LayoutParts | undefined
  render(container, 'Layout', {
    onReady: (value: LayoutParts) => {
      parts = value
    },
  })
  if (!parts) throw new Error('room layout unavailable')
  // Comments (#121) are the paired meta docs of the kept files; the panel
  // shows once the file on screen has one. A read link cannot sign, so it
  // only reads them.
  parts.comments.hidden = true
  const comments = new Store<CommentsView | null>(null),
    threadsShown = new Store<readonly ShownThread[]>([]),
    commentFocus = new Store<string | null>(null),
    commentList = new Store<ThreadList>('open'),
    commentTarget = new Store<CommentTarget | null>(null),
    selection = new Store({ from: 0, to: 0 }),
    locked = new Store(keys.access !== 'edit'),
    panelOpen = new Store(true)
  followFocus(threadsShown, commentFocus, commentList)
  // Images are encrypted blobs in the relay, kept with the room. The host
  // writes them to assets/ on resume, from the links in the text, so no one
  // needs to announce them.
  const attachments = new Attachments({
    roomId: id,
    keys: await deriveBlobKeys(keys.frameSecret, keys.editAdmission ?? keys.readAdmission),
    send: () => {},
    kept: true,
  })
  const notices = new NoticeBoard()
  render(parts.notice, 'Notice', {
    message: notices.message,
    uploading: attachments.uploading,
    onDismiss: () => notices.dismiss(),
  })
  let pending = false
  const client = new KeptTextClient({
    origin: location.origin,
    roomId: id,
    keys,
    doc,
    onStatus: (value) => {
      if (value === 'pending') {
        pending = true
        status.set('saving')
      } else if (value === 'kept') {
        if (pending) status.set('kept')
        pending = false
      } else status.set('retrying')
    },
  })
  const history = lockedUndo(yUndoManagerKeymap, () => editor.state.readOnly).map((binding) => ({
    ...binding,
    run(view: EditorView) {
      binding.run?.(view)
      return true
    },
  }))
  const editable = new Compartment(),
    themeMode = new Compartment(),
    fontMode = new Compartment(),
    wrapMode = new Compartment(),
    vimMode = new Compartment()
  const text = doc.getText('content')
  const undo = new Y.UndoManager(text)
  const undos = new Map([[0, undo]])
  let shown = { text, undo }
  const reader = readerTheme()
  applyText(appearance)
  const extensions = (text: Y.Text, undo: Y.UndoManager, from?: EditorState): Extension[] => {
    const held = (compartment: Compartment, initial: Extension) =>
      (from && compartment.get(from)) ?? initial
    return [
      vimMode.of(held(vimMode, [])),
      basicSetup,
      Prec.high([
        keymap.of(history),
        EditorView.domEventHandlers({
          beforeinput(event, view) {
            const key =
              event.inputType === 'historyUndo'
                ? 'Mod-z'
                : event.inputType === 'historyRedo'
                  ? 'Mod-Shift-z'
                  : undefined
            if (!key) return false
            event.preventDefault()
            history.find((binding) => binding.key === key)?.run(view)
            return true
          },
        }),
      ]),
      markdown(),
      themeMode.of(held(themeMode, theme)),
      fontMode.of(held(fontMode, reader)),
      wrapMode.of(held(wrapMode, lineWrapping(appearance.wrap))),
      editable.of(held(editable, [EditorState.readOnly.of(true), EditorView.editable.of(false)])),
      yCollab(text, null, { undoManager: undo }),
      commentMarks(threadsShown, commentFocus),
      imagePaste({
        blocked: () =>
          editor.state.readOnly
            ? 'Images can be added with an edit link, while the room is open.'
            : null,
        upload: (file) => attachments.upload(file),
        anchor: (pos) => textAnchor(text, pos),
        onError: (message) => notices.show(message),
      }),
      EditorView.updateListener.of((update) => {
        const s = update.state.selection.main,
          was = selection.get()
        if (s.from !== was.from || s.to !== was.to) selection.set({ from: s.from, to: s.to })
      }),
    ]
  }
  const editor: EditorView = new EditorView({
    parent: parts.source,
    state: EditorState.create({ doc: text.toString(), extensions: extensions(text, undo) }),
  })
  const follow = () => {
    if (parts?.main.dataset.view === 'split') preview.follow(editor)
  }
  const alwaysLoad = new AlwaysLoad()
  const preview = new PreviewPane(text, {
    element: parts.preview,
    alwaysLoad,
    images: attachments,
    onRender: follow,
  })
  attachments.version.subscribe(() => preview.refresh())
  const splitter = new Splitter(parts.main, { onResize: follow })
  parts.splitter.replaceChildren(splitter.element)
  const narrow = matchMedia(NARROW_QUERY)
  const view = new ViewSwitch({
    narrow: narrow.matches,
    onApply: (mode) => {
      if (parts) parts.main.dataset.view = mode
      preview.active = mode === 'split' || mode === 'preview'
      editor.requestMeasure()
      follow()
    },
  })
  const resize = () => view.setNarrow(narrow.matches)
  narrow.addEventListener('change', resize)
  editor.scrollDOM.addEventListener('scroll', follow)
  const vim = new VimToggle(editor, vimMode, () =>
    vimExtension({
      undo: () => (editor.state.readOnly ? null : shown.undo.undo()),
      redo: () => (editor.state.readOnly ? null : shown.undo.redo()),
    }),
  )
  const settings = settingsModel(
    editor,
    new ThemeSwitcher(editor, themeMode, themeId),
    wrapMode,
    vim,
    alwaysLoad,
    appearance,
    fontMode,
  )
  if (loadVimMode()) settings.setVim(true)
  render(parts.header, 'Header', {
    status,
    hostAway,
    file,
    view,
    settings,
    access: keys.access === 'edit' ? 'edit' : 'read',
  })
  selection.subscribe((s) => {
    const next = textTarget(s)
    if (!sameTarget(next, commentTarget.get())) commentTarget.set(next)
  })
  const views = new Map<number, CommentsView>()
  let stopThreads = () => {}
  // Shows the comments of the file on screen, once its doc has arrived.
  const showComments = () => {
    const id = current.get()
    const metaId = metaFiles([...client.state.files]).get(id)
    const metaDoc = metaId === undefined ? undefined : client.getDoc(metaId)
    const content = client.getDoc(id)
    let view = views.get(id) ?? null
    if (!view && metaDoc && content) {
      view = new CommentsView(metaDoc, content, {
        name: () => authorName,
        locked: () => locked.get(),
      })
      views.set(id, view)
    }
    if (view === comments.get()) return
    stopThreads()
    comments.set(view)
    commentFocus.set(null)
    if (parts) parts.comments.hidden = view === null
    threadsShown.set(view?.threads.get() ?? [])
    stopThreads = view ? view.threads.subscribe((t) => threadsShown.set(t)) : () => {}
  }
  const openFile = (id: number) => {
    const entry = files.get().find((file) => file.id === id)
    const next = client.getDoc(id)
    if (!entry || !next || current.get() === id) return
    const text = next.getText('content')
    let undo = undos.get(id)
    if (!undo) {
      undo = new Y.UndoManager(text)
      undos.set(id, undo)
    }
    shown = { text, undo }
    editor.setState(
      EditorState.create({
        doc: text.toString(),
        extensions: extensions(text, undo, editor.state),
      }),
    )
    preview.setText(text)
    current.set(id)
    file.set(entry.path)
    selection.set({ from: 0, to: 0 })
    showComments()
    follow()
  }
  render(parts.files, 'FileTabs', { files, current, onOpen: openFile })
  render(parts.banner, 'KeptTextNotice', { deadline, skipped })
  render(parts.comments, 'CommentsPanel', {
    comments,
    target: commentTarget,
    locked,
    focus: commentFocus,
    list: commentList,
    colors: new Store<ReadonlyMap<string, string>>(new Map()),
    menu: new ContextMenu(),
    open: panelOpen,
    onToggle: () => {},
    onShow: (t: ShownThread) => {
      if (t.from < 0 || t.to > editor.state.doc.length) return
      editor.dispatch({ selection: { anchor: t.from, head: t.to }, scrollIntoView: true })
      editor.focus()
    },
  })
  let entries = 0,
    stopped = false,
    loaded = false,
    running = false
  const refresh = async () => {
    if (stopped || running) return
    running = true
    try {
      if (loaded && keys.access === 'edit') await client.flush()
      await client.refresh()
      hostAway.set(client.state.hostAway)
      // Comments docs are listed beside their files but are not files to open.
      files.set(client.state.files.filter((entry) => entry.format === 'text'))
      showComments()
      file.set(
        files.get().find((entry) => entry.id === current.get())?.path || client.state.filename,
      )
      skipped.set(client.state.skipped)
      // An image a guest pasted may have reached the relay since a lookup failed.
      if (client.state.logEntries !== entries) {
        entries = client.state.logEntries
        attachments.reconnected()
      }
      if (!pending)
        status.set(client.state.hostAway || client.state.logEntries > 0 ? 'kept' : 'synced')
      deadline.set(client.state.hostAway ? new Date(client.state.keepUntil).toLocaleString() : null)
      if (!loaded) {
        loaded = true
        editor.dispatch({
          effects: editable.reconfigure([
            EditorState.readOnly.of(keys.access !== 'edit'),
            EditorView.editable.of(keys.access === 'edit'),
          ]),
        })
      }
    } catch (error) {
      if (stopped) return
      if (error instanceof KeptTextClosedError) {
        stopped = true
        clearInterval(timer)
        deadline.set(null)
        locked.set(true)
        editor.dispatch({
          effects: editable.reconfigure([
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ]),
        })
        status.set(error.byHost ? 'host-closed' : 'expired')
        return
      }
      status.set('retrying')
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => {
    void refresh()
  }, 1000)
  const warnPending = (event: BeforeUnloadEvent) => {
    if (pending) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', warnPending)
  window.addEventListener(
    'pagehide',
    () => {
      window.removeEventListener('beforeunload', warnPending)
      stopped = true
      clearInterval(timer)
      narrow.removeEventListener('change', resize)
      settings.destroy()
      preview.active = false
      stopThreads()
      for (const view of views.values()) view.destroy()
      editor.destroy()
      for (const undo of undos.values()) undo.destroy()
      client.close()
      doc.destroy()
    },
    { once: true },
  )
  await refresh()
}
