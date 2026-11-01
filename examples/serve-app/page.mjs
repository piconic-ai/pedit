import { markdown } from '@codemirror/lang-markdown'
import { basicSetup, EditorView } from 'codemirror'
import { yCollab } from 'y-codemirror.next'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

// The document is the one pedit serve holds: the file's text is the Y.Text
// "content", as in a live room.
const doc = new Y.Doc()
const provider = new WebsocketProvider(`ws://${location.host}`, 'file', doc)
const text = doc.getText('content')

const name = `guest-${Math.random().toString(36).slice(2, 6)}`
provider.awareness.setLocalStateField('user', { name, color: '#3b82f6', colorLight: '#3b82f633' })

const status = document.getElementById('status')
provider.on('status', ({ status: s }) => {
  status.textContent = s === 'connected' ? `connected as ${name}` : s
})

new EditorView({
  doc: text.toString(),
  extensions: [basicSetup, markdown(), EditorView.lineWrapping, yCollab(text, provider.awareness)],
  parent: document.getElementById('editor'),
})
