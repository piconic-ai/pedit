// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { EditorView } from '@codemirror/view'
import { deriveRoomKeys, parseFragment } from '@pedit/protocol'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { encrypt } from '../../protocol/src/cipher.ts'
import { APPEARANCE_KEY } from '../src/appearance.ts'
import { joinKeptText } from '../src/kept-text.ts'
import '../src/components/Layout.tsx'

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('CSS', { ...CSS, supports: () => false, escape: (value: string) => value })
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function mount(multiple = false) {
  const room = 'AAECAwQFBgcICQoLDA0ODw',
    fragment = 'A'.repeat(43)
  const link = parseFragment(fragment)
  if (!link) throw new Error('fixture link')
  const keys = await deriveRoomKeys(link, room),
    doc = new Y.Doc()
  doc.getText('content').insert(0, '# Hello')
  let domain = new TextEncoder().encode('pedit kept snapshot v1\0')
  const name = new TextEncoder().encode('notes.md')
  let update = new Uint8Array(2 + name.length + Y.encodeStateAsUpdate(doc).length)
  new DataView(update.buffer).setUint16(0, name.length)
  update.set(name, 2)
  update.set(Y.encodeStateAsUpdate(doc), 2 + name.length)
  if (multiple) {
    domain = new TextEncoder().encode('pedit kept files snapshot v1\0')
    const other = new Y.Doc()
    other.getText('content').insert(0, '# Todo')
    const entries = [
      { id: 0, name, state: Y.encodeStateAsUpdate(doc) },
      { id: 1, name: new TextEncoder().encode('todo.md'), state: Y.encodeStateAsUpdate(other) },
    ]
    update = new Uint8Array(
      2 + entries.reduce((size, entry) => size + 10 + entry.name.length + entry.state.length, 0),
    )
    const view = new DataView(update.buffer)
    view.setUint16(0, 2)
    let offset = 2
    for (const entry of entries) {
      view.setUint32(offset, entry.id)
      view.setUint16(offset + 4, entry.name.length)
      update.set(entry.name, offset + 6)
      offset += 6 + entry.name.length
      view.setUint32(offset, entry.state.length)
      update.set(entry.state, offset + 4)
      offset += 4 + entry.state.length
    }
    other.destroy()
  }
  const message = new Uint8Array(domain.length + update.length)
  message.set(domain)
  message.set(update, domain.length)
  if (!keys.signer) throw new Error('fixture signer')
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.signer.key, message))
  const plain = new Uint8Array(message.length + signature.length)
  plain.set(message)
  plain.set(signature, message.length)
  const snapshot = btoa(String.fromCharCode(...(await encrypt(keys.frameKey, plain))))
  doc.destroy()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        snapshot,
        cutoff: 0,
        tail: 0,
        entries: [],
        hostAway: true,
        keepUntil: Date.now() + 60000,
      }),
    ),
  )
  const container = document.createElement('div')
  document.body.append(container)
  await joinKeptText(container, room, fragment, [])
  const content = container.querySelector('.cm-content')
  if (!(content instanceof HTMLElement)) throw new Error('missing editor')
  const editor = EditorView.findFromDOM(content)
  if (!editor) throw new Error('missing editor view')
  const q = (selector: string) => {
    const result = container.querySelector<HTMLElement>(selector)
    if (!result) throw new Error(`missing ${selector}`)
    return result
  }
  return { container, editor, q, snapshot }
}
it('restores ordinary view controls and updates the actual Markdown preview', async () => {
  const x = await mount()
  expect(x.q('[aria-label="Settings"]')).toBeTruthy()
  expect(x.q('.file').textContent).toBe('notes.md')
  expect(x.q('.status').getAttribute('aria-label')).toContain('waiting for the host')
  expect(x.q('.status svg')).toBeTruthy()
  expect(x.container.textContent).not.toContain('Shared text')
  x.q('button[data-mode="split"]').click()
  expect(x.q('main').dataset.view).toBe('split')
  expect(x.q('.splitter-host [role="separator"]')).toBeTruthy()
  await vi.waitFor(() => expect(x.q('.preview h1').textContent).toBe('Hello'))
  x.editor.dispatch({ changes: { from: x.editor.state.doc.length, insert: ' world' } })
  await vi.waitFor(() => expect(x.q('.preview h1').textContent).toBe('Hello world'))
  x.q('button[data-mode="preview"]').click()
  expect(x.q('main').dataset.view).toBe('preview')
  x.q('button[data-mode="editor"]').click()
  expect(x.q('main').dataset.view).toBe('editor')
})
it('applies ordinary text, theme and Vim settings to the actual retained editor', async () => {
  const x = await mount()
  x.q('[popover]').style.setProperty('display', 'block')
  const field = (label: string) => {
    const row = [...x.container.querySelectorAll('.settings-field, .settings-row')].find(
      (el) =>
        (el.querySelector('.settings-text > span') ?? el.querySelector(':scope > span'))
          ?.textContent === label,
    )
    const input = row?.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error(`missing ${label}`)
    return input
  }
  field('Font size').value = '19'
  field('Font size').dispatchEvent(new Event('input', { bubbles: true }))
  field('Line height').value = '1.9'
  field('Line height').dispatchEvent(new Event('input', { bubbles: true }))
  field('Wrap long lines').checked = false
  field('Wrap long lines').dispatchEvent(new Event('change', { bubbles: true }))
  expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '{}')).toMatchObject({ wrap: false })
  expect(x.editor.contentDOM.classList.contains('cm-lineWrapping')).toBe(false)
  expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '{}')).toMatchObject({
    fontSize: 19,
    lineHeight: 1.9,
    wrap: false,
  })
  x.q('[role="option"][data-value="github-dark"]').click()
  await vi.waitFor(() => expect(x.editor.state.facet(EditorView.darkTheme)).toBe(true))
  field('Vim keybindings').checked = true
  field('Vim keybindings').dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(x.container.querySelector('.cm-vim-panel')).toBeTruthy())
  expect(x.editor.state.readOnly).toBe(false)
})

it('updates status icons and accessible explanations as saving and connectivity change', async () => {
  const x = await mount()
  const status = x.q('.status')
  expect(status.dataset.status).toBe('kept')
  x.editor.dispatch({ changes: { from: x.editor.state.doc.length, insert: '!' } })
  await vi.waitFor(() => expect(status.dataset.status).toBe('saving'))
  expect(status.getAttribute('aria-label')).toContain('Sending')
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(status.dataset.status).toBe('retrying'))
  expect(status.getAttribute('aria-label')).toContain('Retrying')
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 410 }))
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(status.dataset.status).toBe('expired'))
  expect(status.getAttribute('aria-label')).toContain('expired')
  expect(x.editor.state.readOnly).toBe(true)
})

it('keeps the same header controls and view while the host goes offline and returns', async () => {
  const x = await mount()
  const header = x.q('header'),
    settings = x.q('[aria-label="Settings"]')
  x.q('button[data-mode="split"]').click()
  const respond = (hostAway: boolean) =>
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({
        snapshot: x.snapshot,
        cutoff: 0,
        tail: 0,
        entries: [],
        hostAway,
        keepUntil: Date.now() + 60000,
      }),
    )
  respond(false)
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(x.q('.status').dataset.status).toBe('synced'))
  expect(x.q('header')).toBe(header)
  expect(x.q('[aria-label="Settings"]')).toBe(settings)
  expect(x.q('main').dataset.view).toBe('split')
  respond(true)
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(x.q('.status').dataset.status).toBe('kept'))
  expect(x.q('header')).toBe(header)
  expect(x.q('[aria-label="Settings"]')).toBe(settings)
  expect(x.q('main').dataset.view).toBe('split')
  expect(x.container.querySelector('.people')).toBeNull()
  expect(x.container.querySelector('.comments-button')).toBeNull()
})

it('switches retained files without losing pending edits, preview or settings', async () => {
  const x = await mount(true)
  expect(
    [...x.container.querySelectorAll('.file-tabs button')].map((el) => el.textContent),
  ).toEqual(['notes.md', 'todo.md'])
  const notes = x.q('.file-tabs button[title="notes.md"]'),
    todo = x.q('.file-tabs button[title="todo.md"]')
  x.q('button[data-mode="split"]').click()
  x.q('[popover]').style.setProperty('display', 'block')
  const wrapRow = [...x.container.querySelectorAll('.settings-row')].find(
    (row) => row.querySelector('.settings-text > span')?.textContent === 'Wrap long lines',
  )
  const wrap = wrapRow?.querySelector('input')
  if (!(wrap instanceof HTMLInputElement)) throw new Error('missing wrapping setting')
  wrap.checked = false
  wrap.dispatchEvent(new Event('change', { bubbles: true }))
  expect(x.editor.contentDOM.classList.contains('cm-lineWrapping')).toBe(false)

  x.editor.dispatch({ changes: { from: x.editor.state.doc.length, insert: ' notes edit' } })
  todo.click()
  expect(x.q('.file').textContent).toBe('todo.md')
  expect(x.editor.contentDOM.classList.contains('cm-lineWrapping')).toBe(false)
  expect(x.editor.state.doc.toString()).toBe('# Todo')
  x.editor.dispatch({ changes: { from: x.editor.state.doc.length, insert: ' todo edit' } })
  await vi.waitFor(() => expect(x.q('.preview h1').textContent).toBe('Todo todo edit'))
  notes.click()
  expect(x.editor.state.doc.toString()).toBe('# Hello notes edit')
  expect(x.q('main').dataset.view).toBe('split')
  const warn = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(warn)
  expect(warn.defaultPrevented).toBe(true)
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(x.q('.status').dataset.status).toBe('kept'))
  const posts = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')
  expect(posts).toHaveLength(2)
  todo.click()
  expect(x.editor.state.doc.toString()).toBe('# Todo todo edit')
})
it('keeps undo local to each retained file and never undoes its loaded snapshot', async () => {
  const x = await mount(true)
  const undo = () =>
    x.editor.contentDOM.dispatchEvent(
      new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true }),
    )
  x.editor.dispatch({ changes: { from: 7, insert: ' local notes' } })
  x.q('.file-tabs button[title="todo.md"]').click()
  undo()
  expect(x.editor.state.doc.toString()).toBe('# Todo')
  x.editor.dispatch({ changes: { from: 6, insert: ' local todo' } })
  undo()
  expect(x.editor.state.doc.toString()).toBe('# Todo')
  x.q('.file-tabs button[title="notes.md"]').click()
  expect(x.editor.state.doc.toString()).toBe('# Hello local notes')
  undo()
  expect(x.editor.state.doc.toString()).toBe('# Hello')
})
