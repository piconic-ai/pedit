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
    const reload = Object.assign(document.createElement('button'), { textContent: 'Reload' })
    reload.onclick = () => location.reload()
    status.replaceChildren('The document was reset. ', reload)
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

// The share panel. The server owns the share; this page asks it and shows what it reports.
const $ = (id) => document.getElementById(id)
const el = (tag, text, props) =>
  Object.assign(document.createElement(tag), { textContent: text, ...props })
const info = $('share-info')
const peersBox = $('share-peers')

async function ask(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

let shownKeptUntil = 0

function showShared(s) {
  shownKeptUntil = s.keptUntil
  const link = (kind, url) =>
    el('li', `${kind}: `).appendChild(
      el('a', url, { href: url, target: '_blank', rel: 'noopener' }),
    ).parentNode
  const until =
    s.keptUntil > 0 ? `kept until ${new Date(s.keptUntil).toLocaleString()}` : 'live room'
  info.replaceChildren(
    el('p', `Shared (room ${s.room}), ${until}${s.resumed ? ', resumed' : ''}`),
    el('ul'),
  )
  info.lastChild.replaceChildren(...Object.entries(s.links).map(([k, u]) => link(k, u)))
  $('share-start').hidden = true
  $('share-stop').hidden = false
  $('share-close').hidden = s.keptUntil <= 0
}

function showNotShared(message) {
  info.replaceChildren(...(message ? [el('p', message)] : []))
  peersBox.replaceChildren()
  $('share-start').hidden = false
  $('share-stop').hidden = true
  $('share-close').hidden = true
}

function showChoice(r) {
  const labels = { room: 'Keep the room', app: 'Keep this file', later: 'Decide later' }
  info.replaceChildren(
    el('p', `Room ${r.room} already has content from another history. Which one do you keep?`),
    ...r.choices.map((c) =>
      el(
        'button',
        c.text === undefined ? labels[c.choice] : `${labels[c.choice]} (${c.text} characters)`,
        {
          onclick: () => share(c.choice),
        },
      ),
    ),
  )
}

async function share(choice) {
  try {
    const r = await ask('/share', { keep: $('share-keep').value, choice })
    if (r.type === 'shared') showShared(r)
    else if (r.type === 'choice') showChoice(r)
    else showNotShared('The kept room was ended. Nothing is shared.')
  } catch (e) {
    info.replaceChildren(el('p', `cannot share: ${e.message}`))
  }
}

// What leaving says: a kept room waits for the next share; close or a live room ended it.
async function stop(path) {
  const keptUntil = shownKeptUntil
  try {
    await ask(path)
    showNotShared(
      path === '/share/unshare' && keptUntil > 0
        ? `Not shared. The relay keeps the room until ${new Date(keptUntil).toLocaleString()}; Share resumes it.`
        : 'The room ended.',
    )
  } catch (e) {
    info.replaceChildren(el('p', `failed: ${e.message}`))
  }
}

$('share-start').onclick = () => share()
$('share-stop').onclick = () => stop('/share/unshare')
$('share-close').onclick = () => stop('/share/close')

const events = new EventSource('/share/events')
const on = (type, fn) => events.addEventListener(type, (e) => fn(JSON.parse(e.data)))
on('shared', showShared)
on('unshared', () => info.querySelector('ul') && showNotShared())
on('room_ended', (e) => showNotShared(`The room ended (${e.reason}).`))
on('peers', (e) => {
  peersBox.replaceChildren(
    el(
      'p',
      `In the room: ${e.peers.map((p) => `${p.name} (${p.access})`).join(', ') || 'nobody'}${e.more ? ` +${e.more} more` : ''}`,
    ),
  )
})
