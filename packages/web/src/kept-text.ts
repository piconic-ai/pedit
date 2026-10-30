import { render } from '@barefootjs/client/runtime'
import { markdown } from '@codemirror/lang-markdown'
import { Compartment, EditorState, type Extension, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { deriveRoomKeys, parseFragment } from '@pedit/protocol'
import { KeptTextClient, KeptTextClosedError } from '@pedit/protocol/kept-text'
import { basicSetup } from 'codemirror'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { AlwaysLoad } from './alwaysload.ts'
import { type Appearance, applyText, loadAppearance, resolveTheme } from './appearance.ts'
import type { KeptSyncStatus } from './components/KeptTextHeader.tsx'
import type { LayoutParts } from './components/Layout.tsx'
import { PreviewPane } from './pane.ts'
import { lineWrapping, settingsModel } from './settings-model.ts'
import { Splitter } from './splitter.ts'
import { readerTheme, ThemeSwitcher } from './themes.ts'
import { NARROW_QUERY, ViewSwitch } from './view.ts'
import { loadVimMode, VimToggle, vimExtension } from './vim.ts'
import './components/KeptTextHeader.tsx'
import { lockedUndo } from './lockedundo.ts'
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
): Promise<void> {
  const link = parseFragment(key)
  if (!link) throw new Error('invalid room link')
  const keys = await deriveRoomKeys(link, id),
    doc = new Y.Doc()
  const status = new Store<KeptSyncStatus>('connecting'),
    file = new Store<string | null>(null),
    deadline = new Store<string | null>(null),
    skipped = new Store(0)
  let parts: LayoutParts | undefined
  render(container, 'Layout', {
    onReady: (value: LayoutParts) => {
      parts = value
    },
  })
  if (!parts) throw new Error('room layout unavailable')
  parts.comments.hidden = true
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
  const text = doc.getText('content'),
    undo = new Y.UndoManager(text)
  applyText(appearance)
  const editor: EditorView = new EditorView({
    parent: parts.source,
    state: EditorState.create({
      doc: doc.getText('content').toString(),
      extensions: [
        vimMode.of([]),
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
        themeMode.of(theme),
        fontMode.of(readerTheme()),
        wrapMode.of(lineWrapping(appearance.wrap)),
        editable.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        yCollab(text, null, { undoManager: undo }),
      ],
    }),
  })
  const follow = () => {
    if (parts?.main.dataset.view === 'split') preview.follow(editor)
  }
  const alwaysLoad = new AlwaysLoad()
  const preview = new PreviewPane(text, { element: parts.preview, alwaysLoad, onRender: follow })
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
      undo: () => (editor.state.readOnly ? null : undo.undo()),
      redo: () => (editor.state.readOnly ? null : undo.redo()),
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
  render(parts.header, 'KeptTextHeader', {
    status,
    file,
    deadline,
    skipped,
    view,
    settings,
    readOnly: keys.access !== 'edit',
  })
  let stopped = false,
    loaded = false,
    running = false
  const refresh = async () => {
    if (stopped || running) return
    running = true
    try {
      if (loaded && keys.access === 'edit') await client.flush()
      await client.refresh()
      file.set(client.state.filename)
      skipped.set(client.state.skipped)
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
        editor.dispatch({
          effects: editable.reconfigure([
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ]),
        })
        status.set('expired')
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
      client.close()
      narrow.removeEventListener('change', resize)
      settings.destroy()
      preview.active = false
      editor.destroy()
      undo.destroy()
      doc.destroy()
    },
    { once: true },
  )
  await refresh()
}
