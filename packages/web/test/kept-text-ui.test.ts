// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import type { EditorState } from '@codemirror/state'
import { deriveRoomKeys, parseFragment, type RoomKeys } from '@pedit/protocol'
import type { KeptTextClient, KeptTextOptions } from '@pedit/protocol/kept-text'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { encrypt } from '../../protocol/src/cipher.ts'
import type { Readable } from '../src/store.ts'

type Captured = {
  client?: KeptTextClient
  doc?: Y.Doc
  status?: Readable<string>
  skipped?: Readable<number>
  editor?: { state: EditorState; destroyed: boolean }
}
const captured = vi.hoisted(() => {
  const value: Captured = {}
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
    _container: HTMLElement,
    component: string,
    props: {
      onReady?: (parts: unknown) => void
      status?: Readable<string>
      skipped?: Readable<number>
    },
  ) => {
    if (component === 'Layout')
      props.onReady?.({
        header: document.createElement('header'),
        banner: document.createElement('div'),
        files: document.createElement('div'),
        main: document.createElement('main'),
        source: document.createElement('div'),
        comments: document.createElement('div'),
        preview: document.createElement('article'),
        splitter: document.createElement('div'),
      })
    if (component === 'Header') captured.status = props.status
    if (component === 'KeptTextNotice') captured.skipped = props.skipped
  },
}))
vi.mock('@codemirror/view', async (load) => {
  const real = await load<typeof import('@codemirror/view')>()
  return {
    ...real,
    EditorView: class {
      static baseTheme = real.EditorView.baseTheme
      static theme = real.EditorView.theme
      static scrollIntoView = real.EditorView.scrollIntoView
      static domEventHandlers = real.EditorView.domEventHandlers
      static lineWrapping = real.EditorView.lineWrapping
      static editable = real.EditorView.editable
      scrollDOM = document.createElement('div')
      requestMeasure() {}
      state: EditorState
      destroyed = false
      constructor(options: { state: EditorState }) {
        this.state = options.state
        captured.editor = this
      }
      dispatch(transaction: Parameters<EditorState['update']>[0]) {
        this.state = this.state.update(transaction).state
      }
      destroy() {
        this.destroyed = true
      }
    },
  }
})
vi.mock('codemirror', () => ({ basicSetup: [] }))
vi.mock('y-codemirror.next', async (load) => ({
  ...(await load<typeof import('y-codemirror.next')>()),
  yCollab: () => [],
}))
vi.mock('../src/components/Header.tsx', () => ({}))
vi.mock('../src/components/KeptTextNotice.tsx', () => ({}))
const { joinKeptText } = await import('../src/kept-text.ts')
const room = 'AAECAwQFBgcICQoLDA0ODw',
  fragment = 'A'.repeat(43)
const pagehide = () => window.dispatchEvent(new Event('pagehide'))
beforeEach(() => {
  captured.client = undefined
  captured.doc = undefined
  captured.status = undefined
  captured.editor = undefined
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal('CSS', { ...CSS, supports: () => false, escape: (value: string) => value })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})
afterEach(() => {
  pagehide()
  captured.client?.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
async function snapshot() {
  const link = parseFragment(fragment)
  if (!link) throw new Error('fixture link')
  const keys: RoomKeys = await deriveRoomKeys(link, room)
  if (!keys.signer) throw new Error('fixture signer')
  const doc = new Y.Doc()
  try {
    doc.getText('content').insert(0, 'hello')
    const domain = new TextEncoder().encode('pedit kept text v1\0'),
      update = Y.encodeStateAsUpdate(doc),
      message = new Uint8Array(domain.length + update.length)
    message.set(domain)
    message.set(update, domain.length)
    const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.signer.key, message)),
      plain = new Uint8Array(message.length + signature.length)
    plain.set(message)
    plain.set(signature, message.length)
    const encrypted = await encrypt(keys.frameKey, plain)
    return btoa(String.fromCharCode(...encrypted))
  } finally {
    doc.destroy()
  }
}
const response = (encrypted: string) =>
  Response.json({
    snapshot: encrypted,
    entries: [],
    tail: 0,
    cutoff: 0,
    hostAway: true,
    keepUntil: Date.now() + 60000,
  })
it('keeps an edit pending during a read until its append is acknowledged', async () => {
  const encrypted = await snapshot(),
    read = gate(),
    readStarted = gate(),
    append = gate(),
    appendStarted = gate()
  let gets = 0,
    posts = 0
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_, init) => {
      if (init?.method === 'POST') {
        posts++
        appendStarted.release()
        await append.wait
        return Response.json({ id: posts })
      }
      if (++gets === 2) {
        readStarted.release()
        await read.wait
      }
      return response(encrypted)
    }),
  )
  const joined = joinKeptText(document.createElement('div'), room, fragment, [])
  try {
    await joined
    const poll = vi.advanceTimersByTimeAsync(1000)
    await readStarted.wait
    if (!captured.doc || !captured.status) throw new Error('room was not mounted')
    captured.doc.getText('content').insert(5, ' unsent')
    expect(captured.status.get()).toBe('saving')
    read.release()
    await poll
    await captured.client?.refresh()
    const sending = vi.advanceTimersByTimeAsync(1000)
    await appendStarted.wait
    expect(posts).toBe(1)
    expect(captured.status.get()).not.toBe('kept')
    const warn = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(warn)
    expect(warn.defaultPrevented).toBe(true)
    append.release()
    await sending
    await vi.waitFor(() => expect(captured.status?.get()).toBe('kept'))
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
  } finally {
    read.release()
    append.release()
  }
})
it('retries an initial read failure and only enables editing after loading the room', async () => {
  const encrypted = await snapshot()
  let calls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () => {
      if (++calls === 1) throw new Error('transient network failure')
      return response(encrypted)
    }),
  )
  await joinKeptText(document.createElement('div'), room, fragment, [])
  expect(captured.status?.get()).toBe('retrying')
  expect(captured.editor?.state.readOnly).toBe(true)
  expect(vi.getTimerCount()).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(captured.doc?.getText('content').toString()).toBe('hello'))
  await vi.waitFor(() => expect(captured.editor?.state.readOnly).toBe(false))
  expect(captured.status?.get()).not.toContain('Could not load')
  pagehide()
  const count = calls
  await vi.advanceTimersByTimeAsync(5000)
  expect(calls).toBe(count)
  expect(captured.editor?.destroyed).toBe(true)
})

it('publishes skipped invalid-entry count in the browser header while loading valid text', async () => {
  const encrypted = await snapshot()
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      Response.json({
        snapshot: encrypted,
        cutoff: 0,
        tail: 1,
        entries: [{ id: 1, body: '!' }],
        hostAway: true,
        keepUntil: Date.now() + 60000,
      }),
    ),
  )
  await joinKeptText(document.createElement('div'), room, fragment, [])
  expect(captured.doc?.getText('content').toString()).toBe('hello')
  expect(captured.editor?.state.readOnly).toBe(false)
  expect(captured.skipped?.get()).toBe(1)
})

it('distinguishes a relay-held update from a host checkpoint', async () => {
  const encrypted = await snapshot()
  let hostAway = true,
    tail = 0,
    cutoff = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        snapshot: encrypted,
        entries: [],
        tail,
        cutoff,
        hostAway,
        keepUntil: Date.now() + 60000,
      }),
    ),
  )
  await joinKeptText(document.createElement('div'), room, fragment, [])
  expect(captured.status?.get()).toBe('kept')
  hostAway = false
  tail = 1
  // Host presence alone cannot acknowledge a file write.
  // Supply an invalid entry so the client still advances the real relay cursor.
  vi.mocked(fetch).mockImplementation(async () =>
    Response.json({
      snapshot: encrypted,
      entries: cutoff ? [] : [{ id: 1, body: '!' }],
      tail,
      cutoff,
      hostAway,
      keepUntil: Date.now() + 60000,
    }),
  )
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(captured.client?.state.after).toBe(1))
  expect(captured.status?.get()).toBe('kept')
  cutoff = 1
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(captured.status?.get()).toBe('synced'))
})
