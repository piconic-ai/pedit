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
async function mount() {
  const room = 'AAECAwQFBgcICQoLDA0ODw',
    fragment = 'A'.repeat(43)
  const link = parseFragment(fragment)
  if (!link) throw new Error('fixture link')
  const keys = await deriveRoomKeys(link, room),
    doc = new Y.Doc()
  doc.getText('content').insert(0, '# Hello')
  const domain = new TextEncoder().encode('pedit kept snapshot v1\0'),
    name = new TextEncoder().encode('notes.md'),
    update = new Uint8Array(2 + name.length + Y.encodeStateAsUpdate(doc).length)
  new DataView(update.buffer).setUint16(0, name.length)
  update.set(name, 2)
  update.set(Y.encodeStateAsUpdate(doc), 2 + name.length)
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
  return { container, editor, q }
}
it('restores ordinary view controls and updates the actual Markdown preview', async () => {
  const x = await mount()
  expect(x.q('[aria-label="Settings"]')).toBeTruthy()
  expect(x.q('.file').textContent).toBe('notes.md')
  expect(x.q('.kept-status').getAttribute('aria-label')).toContain('waiting for the host')
  expect(x.q('.kept-status svg')).toBeTruthy()
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
  const status = x.q('.kept-status')
  expect(status.dataset.phase).toBe('kept')
  x.editor.dispatch({ changes: { from: x.editor.state.doc.length, insert: '!' } })
  await vi.waitFor(() => expect(status.dataset.phase).toBe('saving'))
  expect(status.getAttribute('aria-label')).toContain('Sending')
  vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'))
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(status.dataset.phase).toBe('retrying'))
  expect(status.getAttribute('title')).toContain('Retrying')
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 410 }))
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(status.dataset.phase).toBe('expired'))
  expect(status.getAttribute('aria-label')).toContain('expired')
  expect(x.editor.state.readOnly).toBe(true)
})
