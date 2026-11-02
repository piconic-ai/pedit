import { markdown } from '@codemirror/lang-markdown'
import { connect } from '@pedit/serve/client'
import { basicSetup, EditorView } from 'codemirror'
import { yCollab } from 'y-codemirror.next'

const status = document.getElementById('status')
try {
  const conn = await connect('/edit', 'demo', {
    name: `guest-${Math.random().toString(36).slice(2, 6)}`,
  })
  const show = (s, error) => {
    if (error?.code !== 'gone') return void (status.textContent = error ? `${s}: ${error.code}` : s)
    // pedit started a new document: this page's copy cannot merge into it. The app decides; here, reload.
    status.innerHTML = 'The document was reset. <button onclick="location.reload()">Reload</button>'
  }
  conn.status.subscribe(show)
  show(conn.status.get())
  new EditorView({
    doc: conn.text.toString(),
    extensions: [basicSetup, markdown(), yCollab(conn.text, conn.awareness)],
    parent: document.getElementById('editor'),
  })
} catch (e) {
  status.textContent = `cannot open the file: ${e.code ?? e.message}`
}
