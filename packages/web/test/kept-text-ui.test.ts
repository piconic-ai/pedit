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
  comments?: Readable<{ start(from: number, to: number, body: string): string | null } | null>
  locked?: Readable<boolean>
  panel?: HTMLElement
  editor?: { state: EditorState; destroyed: boolean }
  paste?: import('../src/paste.ts').ImagePasteOptions
  images?: import('../src/attachments.ts').ImageResolver
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
vi.mock('../src/paste.ts', async (load) => {
  const real = await load<typeof import('../src/paste.ts')>()
  return {
    ...real,
    imagePaste: (options: import('../src/paste.ts').ImagePasteOptions) => {
      captured.paste = options
      return []
    },
  }
})
vi.mock('../src/pane.ts', async (load) => {
  const real = await load<typeof import('../src/pane.ts')>()
  return {
    ...real,
    PreviewPane: class extends real.PreviewPane {
      constructor(...args: ConstructorParameters<typeof real.PreviewPane>) {
        super(...args)
        captured.images = args[1]?.images
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
      comments?: Captured['comments']
      locked?: Readable<boolean>
    },
  ) => {
    if (component === 'Layout')
      props.onReady?.({
        header: document.createElement('header'),
        banner: document.createElement('div'),
        files: document.createElement('div'),
        main: document.createElement('main'),
        source: document.createElement('div'),
        comments: (captured.panel = document.createElement('div')),
        preview: document.createElement('article'),
        splitter: document.createElement('div'),
      })
    if (component === 'Header') captured.status = props.status
    if (component === 'KeptTextNotice') captured.skipped = props.skipped
    if (component === 'CommentsPanel') {
      captured.comments = props.comments
      captured.locked = props.locked
    }
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
      static decorations = real.EditorView.decorations
      static updateListener = real.EditorView.updateListener
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
vi.mock('../src/components/Notice.tsx', () => ({}))
vi.mock('../src/components/Header.tsx', () => ({}))
vi.mock('../src/components/KeptTextNotice.tsx', () => ({}))
vi.mock('../src/components/CommentsPanel.tsx', () => ({}))
const { joinKeptText } = await import('../src/kept-text.ts')
const room = 'AAECAwQFBgcICQoLDA0ODw',
  fragment = 'A'.repeat(43)
const pagehide = () => window.dispatchEvent(new Event('pagehide'))
beforeEach(() => {
  captured.client = undefined
  captured.doc = undefined
  captured.status = undefined
  captured.editor = undefined
  captured.comments = undefined
  captured.locked = undefined
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

/** notes.md ("hello") with its paired comments doc, as a bundle snapshot. */
async function commentedSnapshot() {
  const link = parseFragment(fragment)
  if (!link) throw new Error('fixture link')
  const keys: RoomKeys = await deriveRoomKeys(link, room)
  if (!keys.signer) throw new Error('fixture signer')
  const text = new Y.Doc(),
    comments = new Y.Doc()
  text.getText('content').insert(0, 'hello')
  comments.getMap('comments')
  const utf8 = new TextEncoder(),
    files = [
      { id: 0, path: 'notes.md', update: Y.encodeStateAsUpdate(text) },
      { id: 1024, path: '.pedit/meta/notes.md.json', update: Y.encodeStateAsUpdate(comments) },
    ]
  const body: number[] = [0, files.length]
  const u32 = (n: number) => body.push(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  for (const file of files) {
    const path = utf8.encode(file.path)
    u32(file.id)
    body.push(0, path.length, ...path)
    u32(file.update.length)
    for (const byte of file.update) body.push(byte)
  }
  const domain = utf8.encode('pedit kept files snapshot v1\0'),
    message = Uint8Array.from([...domain, ...body]),
    signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.signer.key, message)),
    encrypted = await encrypt(keys.frameKey, Uint8Array.from([...message, ...signature]))
  return btoa(String.fromCharCode(...encrypted))
}
const stubRoom = (encrypted: string, posts: Uint8Array[] = []) =>
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_, init) => {
      if (init?.method === 'POST') {
        posts.push(new Uint8Array(await new Response(init.body).arrayBuffer()))
        return Response.json({})
      }
      return response(encrypted)
    }),
  )

it('shows the comments of a kept file in the panel', async () => {
  stubRoom(await commentedSnapshot())
  await joinKeptText(document.createElement('div'), room, fragment, [])
  expect(captured.comments?.get()).not.toBeNull()
  expect(captured.panel?.hidden).toBe(false)
  expect(captured.locked?.get()).toBe(false)
})

it('queues a thread started while the host is away and flushes it as an entry of the comments doc', async () => {
  const posts: Uint8Array[] = []
  stubRoom(await commentedSnapshot(), posts)
  await joinKeptText(document.createElement('div'), room, fragment, [])
  expect(captured.comments?.get()?.start(0, 5, 'Which one?')).not.toBeNull()
  expect(captured.status?.get()).toBe('saving')
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() => expect(posts).toHaveLength(1))
  expect(captured.client?.getDoc(1024)?.getMap('comments').size).toBe(1)
  expect(captured.doc?.getText('content').toString()).toBe('hello')
})

it('keeps comments read-only on a read link', async () => {
  const posts: Uint8Array[] = []
  stubRoom(await commentedSnapshot(), posts)
  const link = parseFragment(fragment)
  const edit = link ? await deriveRoomKeys(link, room) : undefined
  const read = edit?.fragments.read
  if (!read) throw new Error('fixture read link')
  await joinKeptText(document.createElement('div'), room, read, [])
  expect(captured.comments?.get()).not.toBeNull()
  expect(captured.locked?.get()).toBe(true)
  expect(captured.comments?.get()?.start(0, 5, 'No')).toBeNull()
  await vi.advanceTimersByTimeAsync(2000)
  expect(posts).toHaveLength(0)
})

// A 1x1 PNG, small enough to go up as it is.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)
it('adds a pasted image to a kept room: uploads it, then links it where it was pasted', async () => {
  // jsdom's Blob does not take another realm's bytes, and has no object URLs.
  vi.stubGlobal('Blob', (await import('node:buffer')).Blob)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:image' }))
  const puts: { url: string; admission: string | null }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/blobs/')) {
        puts.push({
          url: String(input),
          admission: new Headers(init?.headers).get('X-Pedit-Admission'),
        })
        return new Response(null, { status: 201 })
      }
      return response(await snapshot())
    }),
  )
  await joinKeptText(document.createElement('div'), room, fragment, [])
  const link = parseFragment(fragment)
  const keys = link && (await deriveRoomKeys(link, room))
  expect(captured.paste?.blocked()).toBeNull()
  const anchor = captured.paste?.anchor?.(5)
  const path = await captured.paste?.upload(new File([PNG], 'a.png', { type: 'image/png' }))
  expect(path).toMatch(/^assets\/[0-9a-f]{32}\.png$/)
  anchor?.insert(`![](${path})`)
  expect(captured.doc?.getText('content').toString()).toBe(`hello![](${path})`)
  expect(puts).toHaveLength(1)
  expect(puts[0]?.url).toMatch(/^\/api\/rooms\/[A-Za-z0-9_-]{22}\/blobs\/[A-Za-z0-9_-]{22}$/)
  expect(puts[0]?.admission).toBe(keys?.editAdmission)
  // The same page shows it without asking the relay again.
  expect(captured.images?.lookup(path ?? '')).toMatchObject({ url: expect.any(String) })
})
it('does not let a read link paste images, and shows the ones the room keeps', async () => {
  const link = parseFragment(fragment)
  const edit = link ? await deriveRoomKeys(link, room) : undefined
  const read = edit?.fragments.read
  if (!read || !edit) throw new Error('fixture read link')
  const hash = '0'.repeat(32)
  const requests: (string | null)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/blobs/')) {
        requests.push(new Headers(init?.headers).get('X-Pedit-Admission'))
        return new Response(null, { status: 404 })
      }
      return response(await snapshot())
    }),
  )
  await joinKeptText(document.createElement('div'), room, read, [])
  expect(captured.paste?.blocked()).not.toBeNull()
  expect(captured.images?.lookup(`assets/${hash}.png`)).toBe('loading')
  await vi.waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]).toBe(edit.readAdmission)
})
