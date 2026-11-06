// @vitest-environment jsdom

import { EditorView } from '@codemirror/view'
import { type FileEntry, RoomClient, type RoomKeys, type RoomStatus } from '@pedit/protocol'
import { Awareness, editKeys, Relay, TEST_ROOM, Y } from '@pedit/protocol/testing'
import { basicSetup } from 'codemirror'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountBanner, mountNotice } from '../../src/core/banner.ts'
import { mountComments } from '../../src/core/comments-mount.ts'
import { mountTextEditor } from '../../src/core/editor.ts'
import { FileSet } from '../../src/core/files.ts'
import { openRoom } from '../../src/core/open-room.ts'
import { Store } from '../../src/core/store.ts'

beforeAll(() => {
  // jsdom lays nothing out; CodeMirror measures text ranges.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
})

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

/** The review core mounted into a shadow root, as `<pedit-review>` does it. */
async function mount(access: 'edit' | 'read' = 'edit', relay = new Relay()) {
  const keys: RoomKeys = await editKeys()
  const host = document.body.appendChild(document.createElement('div'))
  const root = host.attachShadow({ mode: 'open' })
  const slot = (cls: string) => {
    const el = document.createElement('div')
    el.className = cls
    root.append(el)
    return el
  }
  const bannerEl = slot('banner')
  const noticeEl = slot('notice')
  const editorEl = slot('editor')
  const commentsEl = slot('comments')
  const room = await openRoom({
    relay: new URL('https://relay.test'),
    roomId: TEST_ROOM,
    fragment: keys.fragments[access] as string,
    me: { name: 'Guest' },
    createSocket: relay.create,
  })
  const files = new FileSet(room, { name: 'Guest' })
  const editor = mountTextEditor({ room, files, parent: editorEl as HTMLElement, root })
  const comments = mountComments({
    room,
    files,
    editor: editor.view,
    parent: commentsEl as HTMLElement,
    keyTarget: root,
    narrow: new Store(false),
    prefs: null,
  })
  const onReconnect = vi.fn()
  const stopBanner = mountBanner(bannerEl as HTMLElement, room, { onReconnect })
  const stopNotice = mountNotice(noticeEl as HTMLElement, room)
  const dispose = async () => {
    stopNotice()
    stopBanner()
    comments.dispose()
    editor.dispose()
    files.dispose()
    await room.dispose()
  }
  cleanups.push(dispose)
  /** The host's side: the list of files that names the comments' file. */
  const manifest = () => {
    const awareness = new Awareness(new Y.Doc())
    awareness.setLocalState({ role: 'host' })
    const peer = new RoomClient({
      admissionToken: 'A'.repeat(43),
      url: 'ws://test',
      keys,
      doc: awareness.doc,
      awareness,
      createSocket: relay.create,
      minBackoffMs: 1,
    })
    cleanups.push(() => peer.destroy())
    peer.connect()
    const list: FileEntry[] = [
      { id: 0, path: 'notes.md', format: 'text' },
      { id: 1, path: '.pedit/meta/notes.md.json', format: 'meta' },
    ]
    peer.setManifest(list)
  }
  return {
    room,
    files,
    editor,
    comments,
    host,
    root,
    banner: bannerEl,
    notice: noticeEl,
    commentsEl,
    onReconnect,
    manifest,
    dispose,
  }
}

type Mounted = Awaited<ReturnType<typeof mount>>

const go = (room: Mounted['room'], s: RoomStatus) => {
  const was = room.editLocked()
  room.status.set(s)
  room.hooks.status?.(s, was)
}

/** The document and window listeners added while `run` goes, as "target:type" sorted. */
async function listenersAdded(run: () => Promise<void>): Promise<string[]> {
  const added: string[] = []
  const note = (target: string) =>
    function (type: string) {
      added.push(`${target}:${type}`)
    }
  const d = vi.spyOn(document, 'addEventListener').mockImplementation(note('document') as never)
  const w = vi.spyOn(window, 'addEventListener').mockImplementation(note('window') as never)
  try {
    await run()
  } finally {
    d.mockRestore()
    w.mockRestore()
  }
  return added.sort()
}

/**
 * Makes every read of the page's own URL observable, on `window` and on
 * `document`. jsdom makes `document.location` unforgeable (as browsers do), so
 * that one cannot be stubbed here; `window.location` and the global are.
 */
function watchLocation() {
  const read = vi.fn(() => 'https://page.test/')
  const stubbed: [object, PropertyDescriptor | undefined][] = []
  for (const t of [window, document, globalThis]) {
    const was = Object.getOwnPropertyDescriptor(t, 'location')
    try {
      Object.defineProperty(t, 'location', { configurable: true, get: read })
      stubbed.push([t, was])
    } catch {
      // Unforgeable here.
    }
  }
  return {
    read,
    restore() {
      for (const [t, d] of stubbed.reverse()) {
        if (d) Object.defineProperty(t, 'location', d)
        else delete (t as { location?: unknown }).location
      }
    },
  }
}

const key = (over: KeyboardEventInit) =>
  new KeyboardEvent('keydown', {
    key: 'm',
    code: 'KeyM',
    altKey: true,
    bubbles: true,
    cancelable: true,
    ...over,
  })

/** The editor with the basic setup alone, in a shadow root of its own: what CodeMirror adds by itself. */
async function bareEditor(): Promise<string[]> {
  return listenersAdded(async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const view = new EditorView({
      parent: host.attachShadow({ mode: 'open' }),
      extensions: [basicSetup],
    })
    view.destroy()
  })
}

describe('the core in a shadow root', () => {
  it('adds only the listeners CodeMirror adds, and reads no location', async () => {
    const baseline = await bareEditor()
    const watch = watchLocation()
    let m: Mounted | undefined
    let added: string[]
    try {
      added = await listenersAdded(async () => {
        m = await mount()
        m.room.connect()
        go(m.room, 'closed')
        go(m.room, 'connected')
        await m.dispose()
      })
    } finally {
      watch.restore()
    }
    expect(watch.read).not.toHaveBeenCalled()
    // One editor, so exactly what a bare editor adds: nothing from the core.
    expect(added).toEqual(baseline)
  })

  it('opens the comments panel on the platform key inside the shadow root and focuses its box', async () => {
    const m = await mount()
    m.room.connect()
    m.manifest()
    await vi.waitFor(() => expect(m.files.commentable.get()).toBe(true))
    m.comments.open.set(false)
    // A selection to comment on shows the new comment's box.
    m.files.target.set({ kind: 'text', from: 0, to: 1 })
    await vi.waitFor(() =>
      expect(m.root.querySelector<HTMLElement>('.comments-new')?.hidden).toBe(false),
    )
    // Not a Mac: Ctrl, and Command alone does nothing.
    const meta = key({ metaKey: true })
    m.root.dispatchEvent(meta)
    expect(meta.defaultPrevented).toBe(false)
    expect(m.comments.open.get()).toBe(false)
    const ctrl = key({ ctrlKey: true })
    m.root.dispatchEvent(ctrl)
    expect(ctrl.defaultPrevented).toBe(true)
    expect(m.comments.open.get()).toBe(true)
    const box = m.root.querySelector<HTMLTextAreaElement>('.comments-new textarea')
    expect(box).not.toBeNull()
    expect(m.root.activeElement).toBe(box)
  })

  it('takes Command, not Ctrl, on a Mac', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X)',
    )
    const m = await mount()
    m.room.connect()
    m.manifest()
    await vi.waitFor(() => expect(m.files.commentable.get()).toBe(true))
    m.comments.open.set(false)
    const ctrl = key({ ctrlKey: true })
    m.root.dispatchEvent(ctrl)
    expect(ctrl.defaultPrevented).toBe(false)
    expect(m.comments.open.get()).toBe(false)
    const meta = key({ metaKey: true })
    m.root.dispatchEvent(meta)
    expect(meta.defaultPrevented).toBe(true)
    expect(m.comments.open.get()).toBe(true)
  })

  it.each(['edit', 'read'] as const)(
    'does nothing on the key while there are no comments to write (%s link)',
    async (access) => {
      const m = await mount(access)
      m.room.connect()
      expect(m.files.commentable.get()).toBe(false)
      m.comments.open.set(false)
      const e = key({ ctrlKey: true })
      m.root.dispatchEvent(e)
      expect(e.defaultPrevented).toBe(false)
      expect(m.comments.open.get()).toBe(false)
    },
  )

  it('calls the injected hook when the banner reconnects', async () => {
    const m = await mount()
    go(m.room, 'maintenance')
    const buttons = [
      ...(m.root.querySelectorAll('.banner button') as NodeListOf<HTMLButtonElement>),
    ]
    const reconnect = buttons.find((b) => b.textContent === 'Reconnect') as HTMLButtonElement
    expect(reconnect.hidden).toBe(false)
    reconnect.click()
    expect(m.onReconnect).toHaveBeenCalledTimes(1)
  })

  it('draws nothing outside the shadow root', async () => {
    const m = await mount()
    m.room.connect()
    go(m.room, 'closed')
    expect([...document.body.children]).toEqual([m.host])
    expect(m.host.children.length).toBe(0)
    expect(m.root.querySelector('.cm-editor')).not.toBeNull()
  })

  it('reacts to nothing once disposed', async () => {
    const m = await mount()
    m.room.connect()
    m.manifest()
    await vi.waitFor(() => expect(m.files.commentable.get()).toBe(true))
    expect(m.banner.children.length).toBe(1)
    expect(m.commentsEl.children.length).toBe(1)
    m.comments.open.set(false)
    // The component itself stops reacting, not only its place in the page.
    const shown = m.banner.querySelector('.banner') as HTMLElement
    await m.dispose()
    expect(m.banner.children.length).toBe(0)
    expect(m.notice.children.length).toBe(0)
    expect(m.commentsEl.children.length).toBe(0)
    // A thread in focus opened the panel; now it does not, nor does the shortcut.
    m.files.focus.set('t1')
    const e = key({ ctrlKey: true })
    m.root.dispatchEvent(e)
    expect(m.comments.open.get()).toBe(false)
    expect(e.defaultPrevented).toBe(false)
    go(m.room, 'closed')
    expect(shown.hidden).toBe(true)
    expect(m.banner.children.length).toBe(0)
    expect(m.commentsEl.children.length).toBe(0)
  })
})
