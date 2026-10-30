import { render } from '@barefootjs/client/runtime'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { deriveRoomKeys, parseFragment } from '@pedit/protocol'
import { KeptTextClient, KeptTextClosedError } from '@pedit/protocol/kept-text'
import { basicSetup } from 'codemirror'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import type { LayoutParts } from './components/Layout.tsx'
import './components/KeptTextHeader.tsx'
import { Store } from './store.ts'

export async function joinKeptText(
  container: HTMLElement,
  id: string,
  key: string,
  theme: Extension,
): Promise<void> {
  const link = parseFragment(key)
  if (!link) throw new Error('invalid room link')
  const keys = await deriveRoomKeys(link, id),
    doc = new Y.Doc()
  const status = new Store('Connecting…'),
    deadline = new Store<string | null>(null)
  let parts: LayoutParts | undefined
  render(container, 'Layout', {
    onReady: (value: LayoutParts) => {
      parts = value
    },
  })
  if (!parts) throw new Error('room layout unavailable')
  render(parts.header, 'KeptTextHeader', { status, deadline, readOnly: keys.access !== 'edit' })
  parts.main.dataset.view = 'editor'
  parts.comments.hidden = true
  let pending = false
  const client = new KeptTextClient({
    origin: location.origin,
    roomId: id,
    keys,
    doc,
    onStatus: (value) => {
      if (value === 'pending') pending = true
      if (value === 'kept') pending = false
      status.set(
        value === 'pending'
          ? 'Saving your edits…'
          : value === 'kept'
            ? 'Edits kept'
            : 'Edits have not been sent. Retrying…',
      )
    },
  })
  const editable = new Compartment()
  const editor = new EditorView({
    parent: parts.source,
    state: EditorState.create({
      doc: doc.getText('content').toString(),
      extensions: [
        basicSetup,
        theme,
        EditorView.lineWrapping,
        editable.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        yCollab(doc.getText('content'), null),
      ],
    }),
  })
  let stopped = false,
    loaded = false,
    again = false,
    running = false
  const refresh = async () => {
    if (stopped) return
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        if (loaded && keys.access === 'edit') await client.flush()
        await client.refresh()
        deadline.set(
          client.state.hostAway ? new Date(client.state.keepUntil).toLocaleString() : null,
        )
        if (!loaded) {
          loaded = true
          editor.dispatch({
            effects: editable.reconfigure([
              EditorState.readOnly.of(keys.access !== 'edit'),
              EditorView.editable.of(keys.access === 'edit'),
            ]),
          })
          status.set('Connected')
        } else if (keys.access !== 'edit') status.set('Connected')
      } while (again && !stopped)
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
        status.set('This room has expired.')
        return
      }
      status.set(loaded ? 'Connection lost. Retrying…' : 'Could not load the room. Retrying…')
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => {
    void refresh()
  }, 1000)
  const update = () => {
    void refresh()
  }
  doc.on('update', update)
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
      editor.destroy()
      doc.destroy()
    },
    { once: true },
  )
  await refresh()
}
