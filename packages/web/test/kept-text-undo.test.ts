// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { EditorView } from '@codemirror/view'
import { deriveRoomKeys, parseFragment, type RoomKeys } from '@pedit/protocol'
import type { KeptTextClient, KeptTextOptions } from '@pedit/protocol/kept-text'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { encrypt } from '../../protocol/src/cipher.ts'

const captured = vi.hoisted(() => {
  const value: { client?: KeptTextClient; doc?: Y.Doc } = {}
  return value
})
vi.mock('@pedit/protocol/kept-text', async (load) => {
  const real = await load<typeof import('@pedit/protocol/kept-text')>()
  return {
    ...real,
    KeptTextClient: class extends real.KeptTextClient {
      constructor(options: KeptTextOptions) {
        super(options)
        captured.client = this
        captured.doc = options.doc
      }
    },
  }
})
vi.mock('@barefootjs/client/runtime', async (load) => ({
  ...(await load<typeof import('@barefootjs/client/runtime')>()),
  render: (
    container: HTMLElement,
    component: string,
    props: { onReady?: (parts: unknown) => void },
  ) => {
    if (component !== 'Layout') return
    const header = document.createElement('header'),
      main = document.createElement('main'),
      source = document.createElement('div'),
      comments = document.createElement('div')
    main.append(source, comments)
    container.append(header, main)
    props.onReady?.({
      header,
      main,
      source,
      comments,
      preview: document.createElement('article'),
      splitter: document.createElement('div'),
    })
  },
}))
vi.mock('../src/components/KeptTextHeader.tsx', () => ({}))
const { joinKeptText } = await import('../src/kept-text.ts')
const room = 'AAECAwQFBgcICQoLDA0ODw',
  fragment = 'A'.repeat(43)
const documents: Y.Doc[] = []

beforeEach(() => {
  captured.client = undefined
  captured.doc = undefined
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal('CSS', { ...CSS, supports: () => false, escape: (value: string) => value })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0)
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  captured.client?.close()
  for (const doc of documents.splice(0)) doc.destroy()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function sign(keys: RoomKeys, doc: Y.Doc): Promise<string> {
  if (!keys.signer) throw new Error('fixture signer')
  const domain = new TextEncoder().encode('pedit kept text v1\0'),
    update = Y.encodeStateAsUpdate(doc),
    message = new Uint8Array(domain.length + update.length)
  message.set(domain)
  message.set(update, domain.length)
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.signer.key, message)),
    plain = new Uint8Array(message.length + signature.length)
  plain.set(message)
  plain.set(signature, message.length)
  return btoa(String.fromCharCode(...(await encrypt(keys.frameKey, plain))))
}
async function setup(access: 'edit' | 'read' | 'comment' = 'edit', initial = 'host') {
  const link = parseFragment(fragment)
  if (!link) throw new Error('fixture link')
  const keys = await deriveRoomKeys(link, room),
    host = new Y.Doc()
  documents.push(host)
  host.getText('content').insert(0, initial)
  let snapshot = await sign(keys, host),
    closed = false,
    appends = 0
  const entries: { id: number; body: string }[] = []
  const reads: { after: number; bytes: number; snapshot: boolean }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (closed) return new Response(null, { status: 410 })
      if (init?.method === 'POST') {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer())
        entries.push({ id: ++appends, body: btoa(String.fromCharCode(...bytes)) })
        return Response.json({ id: appends })
      }
      const after = Number(new URL(String(input)).searchParams.get('after') ?? '0')
      const value = {
        ...(after === 0 ? { snapshot } : {}),
        cutoff: 0,
        tail: appends,
        entries: entries.filter((entry) => entry.id > after),
        hostAway: true,
        keepUntil: Date.now() + 60000,
      }
      reads.push({ after, bytes: JSON.stringify(value).length, snapshot: 'snapshot' in value })
      return Response.json(value)
    }),
  )
  const container = document.createElement('div')
  document.body.append(container)
  await joinKeptText(container, room, keys.fragments[access] ?? '', [])
  const content = container.querySelector('.cm-content')
  if (!(content instanceof HTMLElement) || !captured.client || !captured.doc)
    throw new Error('editor unavailable')
  const view = EditorView.findFromDOM(content)
  if (!view) throw new Error('editor view unavailable')
  const client = captured.client,
    doc = captured.doc
  return {
    view,
    doc,
    client,
    close: () => {
      closed = true
    },
    appends: () => appends,
    reads,
    peer: async () => {
      host.getText('content').insert(host.getText('content').length, ' peer')
      snapshot = await sign(keys, host)
      await client.refresh()
    },
  }
}
function press(view: EditorView, redo = false): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: redo ? 'Z' : 'z',
      code: 'KeyZ',
      keyCode: 90,
      ctrlKey: !/Mac/.test(navigator.platform),
      metaKey: /Mac/.test(navigator.platform),
      shiftKey: redo,
      bubbles: true,
      cancelable: true,
    }),
  )
}
function native(view: EditorView, inputType: 'historyUndo' | 'historyRedo'): void {
  const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true })
  view.contentDOM.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
}

it('never undoes initial or peer state, even when the local Yjs undo stack is empty', async () => {
  const x = await setup()
  press(x.view)
  expect(x.doc.getText('content').toString()).toBe('host')
  native(x.view, 'historyUndo')
  expect(x.doc.getText('content').toString()).toBe('host')
  expect(x.appends()).toBe(0)
  x.view.dispatch({ changes: { from: 4, insert: ' local' } })
  await x.peer()
  const both = x.doc.getText('content').toString()
  expect(both).toContain('local')
  expect(both).toContain('peer')
  press(x.view)
  expect(x.doc.getText('content').toString()).toBe('host peer')
  press(x.view)
  expect(x.doc.getText('content').toString()).toBe('host peer')
  press(x.view, true)
  expect(x.doc.getText('content').toString()).toBe(both)
  native(x.view, 'historyUndo')
  expect(x.doc.getText('content').toString()).toBe('host peer')
  native(x.view, 'historyRedo')
  expect(x.doc.getText('content').toString()).toBe(both)
})
it.each(['read', 'comment'] as const)(
  'does not mutate loaded text through keyboard or native history with a %s link',
  async (access) => {
    const x = await setup(access)
    expect(x.view.state.readOnly).toBe(true)
    press(x.view)
    press(x.view, true)
    native(x.view, 'historyUndo')
    native(x.view, 'historyRedo')
    expect(x.doc.getText('content').toString()).toBe('host')
    expect(x.appends()).toBe(0)
  },
)
it('locks both existing undo and redo stacks after the relay expires', async () => {
  const x = await setup()
  x.view.dispatch({ changes: { from: 4, insert: ' one' } })
  await new Promise((resolve) => setTimeout(resolve, 550))
  x.view.dispatch({ changes: { from: 8, insert: ' two' } })
  press(x.view)
  expect(x.doc.getText('content').toString()).toBe('host one')
  await x.client.flush()
  x.close()
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(x.view.state.readOnly).toBe(true))
  for (const action of [
    () => press(x.view),
    () => press(x.view, true),
    () => native(x.view, 'historyUndo'),
    () => native(x.view, 'historyRedo'),
  ]) {
    action()
    expect(x.doc.getText('content').toString()).toBe('host one')
    expect(x.view.state.doc.toString()).toBe('host one')
  }
})

it('consumes an empty Yjs undo command even if it returns false instead of falling through to ordinary history', async () => {
  const binding = yUndoManagerKeymap.find((value) => value.key === 'Mod-z')
  if (!binding?.run) throw new Error('Yjs undo command unavailable')
  vi.spyOn(binding, 'run').mockReturnValueOnce(false)
  const x = await setup()
  press(x.view)
  expect(x.doc.getText('content').toString()).toBe('host')
  expect(x.view.state.doc.toString()).toBe('host')
  expect(x.appends()).toBe(0)
})

it('batches 2000 character updates into one append at the next one-second flush', async () => {
  const x = await setup()
  for (let i = 0; i < 2000; i++)
    x.view.dispatch({ changes: { from: x.view.state.doc.length, insert: 'x' } })
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(x.appends()).toBe(0)
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(x.appends()).toBe(1))
  expect(x.doc.getText('content').length).toBe(2004)
})
it('transfers only small status bodies on unchanged browser polls after loading a large document', async () => {
  const x = await setup('edit', 'x'.repeat(100000))
  x.view.dispatch({ changes: { from: 100000, insert: ' local' } })
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(x.appends()).toBe(1))
  x.reads.length = 0
  await vi.advanceTimersByTimeAsync(1000)
  await vi.advanceTimersByTimeAsync(1000)
  expect(x.reads).toHaveLength(2)
  expect(x.reads.every((read) => read.after === 1 && !read.snapshot && read.bytes < 300)).toBe(true)
})
