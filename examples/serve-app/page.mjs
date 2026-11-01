import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { connect } from '@pedit/serve/client'
import { basicSetup, EditorView } from 'codemirror'
import { yCollab } from 'y-codemirror.next'

const status = document.getElementById('status')
const name = `guest-${Math.random().toString(36).slice(2, 6)}`

// `gone`: pedit lost the document's history (its saved state was discarded), so this page's
// copy cannot be merged into the new one. What the page typed is still in `conn.doc`; the app
// decides between copying it out and reloading. This sample offers both.
function offerCopy(conn, error) {
  status.textContent = `${error.message}. `
  const copy = document.createElement('button')
  copy.textContent = 'Copy your text'
  copy.onclick = async () => {
    await navigator.clipboard.writeText(conn.text.toString())
    copy.textContent = 'Copied'
  }
  const reload = document.createElement('button')
  reload.textContent = 'Reload'
  reload.onclick = () => location.reload()
  status.append(copy, ' ', reload)
}

try {
  const conn = await connect('/edit', 'demo', { name, color: '#3b82f6' })
  const show = (s, error) => {
    if (error?.code === 'gone') return offerCopy(conn, error)
    status.textContent = error
      ? `${s}: ${error.code}`
      : s === 'connected'
        ? `connected as ${name}`
        : s
  }
  conn.status.subscribe(show)
  show(conn.status.get())
  new EditorView({
    doc: conn.text.toString(),
    extensions: [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      yCollab(conn.text, conn.awareness),
      // A reader never sends updates; this also stops the editor from accepting input.
      EditorState.readOnly.of(conn.role === 'read'),
    ],
    parent: document.getElementById('editor'),
  })
} catch (e) {
  status.textContent = `cannot open the file: ${e.code ?? e.message}`
}
