// @vitest-environment jsdom
import { type FileEntry, RoomClient, type RoomKeys, type RoomStatus } from '@pedit/protocol'
import { Awareness, editKeys, Relay, TEST_ROOM, Y } from '@pedit/protocol/testing'
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

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

/** The review core mounted into a shadow root, as `<pedit-review>` does it. */
async function mount(relay = new Relay()) {
  const keys: RoomKeys = await editKeys()
  const host = document.body.appendChild(document.createElement('div'))
  const root = host.attachShadow({ mode: 'open' })
  const slot = (cls: string) => {
    const el = document.createElement('div')
    el.className = cls
    root.append(el)
    return el
  }
  const [bannerEl, noticeEl, editorEl, commentsEl] = ['banner', 'notice', 'editor', 'comments'].map(
    slot,
  )
  const room = await openRoom({
    relay: new URL('https://relay.test'),
    roomId: TEST_ROOM,
    fragment: keys.fragments.edit as string,
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
  mountBanner(bannerEl as HTMLElement, room, { onReconnect })
  mountNotice(noticeEl as HTMLElement, room)
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
    peer.connect()
    const list: FileEntry[] = [
      { id: 0, path: 'notes.md', format: 'text' },
      { id: 1, path: '.pedit/meta/notes.md.json', format: 'meta' },
    ]
    peer.setManifest(list)
    return peer
  }
  return { room, files, editor, comments, host, root, onReconnect, manifest }
}

const go = (room: Awaited<ReturnType<typeof mount>>['room'], s: RoomStatus) => {
  const was = room.editLocked()
  room.status.set(s)
  room.hooks.status?.(s, was)
}

describe('the core in a shadow root', () => {
  it('adds no document or window listener and reads no location', async () => {
    const onDocument = vi.spyOn(document, 'addEventListener')
    const onWindow = vi.spyOn(window, 'addEventListener')
    const read = vi.fn(() => 'https://page.test/')
    const was = Object.getOwnPropertyDescriptor(window, 'location')
    // Where a page's own URL would come from, if the core reached for it.
    Object.defineProperty(window, 'location', { configurable: true, get: read })
    try {
      const m = await mount()
      m.room.connect()
      go(m.room, 'closed')
      go(m.room, 'connected')
      m.comments.dispose()
      m.editor.dispose()
      m.files.dispose()
      await m.room.dispose()
    } finally {
      if (was) Object.defineProperty(window, 'location', was)
    }
    expect(read).not.toHaveBeenCalled()
    // CodeMirror itself listens for selectionchange, resize, scroll and
    // beforeprint (and removes them on destroy); the core adds nothing else.
    const added = (spy: typeof onDocument) =>
      spy.mock.calls
        .map((c) => c[0])
        .filter((t) => !['selectionchange', 'resize', 'beforeprint', 'scroll'].includes(t))
    expect(added(onDocument)).toEqual([])
    expect(added(onWindow)).toEqual([])
  })

  it('opens the comments panel on Ctrl+Alt+M inside the shadow root and focuses its box', async () => {
    const m = await mount()
    m.room.connect()
    const peer = m.manifest()
    await vi.waitFor(() => expect(m.files.commentable.get()).toBe(true))
    m.comments.open.set(false)
    // A selection to comment on shows the new comment's box.
    m.files.target.set({ kind: 'text', from: 0, to: 1 })
    await vi.waitFor(() =>
      expect(m.root.querySelector<HTMLElement>('.comments-new')?.hidden).toBe(false),
    )
    m.root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'm',
        code: 'KeyM',
        ctrlKey: true,
        metaKey: true,
        altKey: true,
        bubbles: true,
      }),
    )
    expect(m.comments.open.get()).toBe(true)
    const box = m.root.querySelector<HTMLTextAreaElement>('.comments-new textarea')
    expect(box).not.toBeNull()
    expect(m.root.activeElement).toBe(box)
    m.comments.dispose()
    await peer.destroy()
  })

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
})
