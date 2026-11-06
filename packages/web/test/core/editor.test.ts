// @vitest-environment jsdom
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { type FileEntry, type RoomKeys, type RoomStatus } from '@pedit/protocol'
import { editKeys, Relay, TEST_ROOM } from '@pedit/protocol/testing'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ShownThread } from '../../src/core/comments.ts'
import { mountTextEditor, type TextEditor } from '../../src/core/editor.ts'
import { FileSet, type OpenFile } from '../../src/core/files.ts'
import { openRoom, type Room } from '../../src/core/open-room.ts'

beforeAll(() => {
  // jsdom lays nothing out; CodeMirror measures text ranges.
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () => new DOMRect()
})

const rooms: Room[] = []
const editors: TextEditor[] = []
afterEach(async () => {
  for (const e of editors.splice(0)) e.dispose()
  for (const r of rooms.splice(0)) await r.dispose()
  document.body.replaceChildren()
})

async function setup(
  access: 'edit' | 'read' = 'edit',
  root?: ShadowRoot,
  parent?: HTMLElement,
  extra?: Parameters<typeof mountTextEditor>[0]['extra'],
  before?: (room: Room) => void,
) {
  const keys: RoomKeys = await editKeys()
  const room = await openRoom({
    relay: new URL('https://relay.test'),
    roomId: TEST_ROOM,
    fragment: keys.fragments[access] as string,
    me: { name: 'Guest' },
    createSocket: new Relay().create,
  })
  rooms.push(room)
  const files = new FileSet(room, { name: 'Guest' })
  before?.(room)
  const host = parent ?? document.body.appendChild(document.createElement('div'))
  const editor = mountTextEditor({ room, files, parent: host, root, extra })
  editors.push(editor)
  return { room, files, editor }
}

/** The room's status changes the way the room does it. */
function go(room: Room, s: RoomStatus) {
  const was = room.editLocked()
  room.status.set(s)
  room.hooks.status?.(s, was)
}

const editable = (e: TextEditor) => e.view.state.facet(EditorView.editable)

describe('mountTextEditor', () => {
  it('starts from the text the file already has', async () => {
    const { room, editor } = await setup('edit', undefined, undefined, undefined, (r) =>
      r.text.insert(0, 'already here'),
    )
    expect(editor.view.state.doc.toString()).toBe('already here')
    // And stays in step with it.
    room.text.insert(room.text.length, '!')
    expect(editor.view.state.doc.toString()).toBe('already here!')
  })

  it('mounts read-only into a room that is already locked or has ended', async () => {
    for (const s of ['waiting', 'log-full', 'closed'] as RoomStatus[]) {
      const { editor } = await setup('edit', undefined, undefined, undefined, (r) =>
        r.status.set(s),
      )
      expect(editor.view.state.readOnly).toBe(true)
      expect(editable(editor)).toBe(false)
    }
    const { editor } = await setup('edit', undefined, undefined, undefined, (r) =>
      r.status.set('kept'),
    )
    expect(editor.view.state.readOnly).toBe(false)
  })

  it('mounts read-only for a read link and editable for an edit link', async () => {
    expect((await setup('read')).editor.view.state.readOnly).toBe(true)
    const { editor } = await setup('edit')
    expect(editor.view.state.readOnly).toBe(false)
    expect(editable(editor)).toBe(true)
  })

  it('goes read-only and locks undo when the room ends', async () => {
    const { room, editor, files } = await setup()
    const text = files.shown.get().text
    const ctrlZ = () =>
      runScopeHandlers(
        editor.view,
        new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }),
        'editor',
      )
    go(room, 'connected')
    editor.view.dispatch({ changes: { from: 0, insert: 'abc' } })
    ctrlZ()
    expect(text.toString()).toBe('')
    editor.view.dispatch({ changes: { from: 0, insert: 'abc' } })
    go(room, 'closed')
    expect(editable(editor)).toBe(false)
    expect(editor.view.state.readOnly).toBe(true)
    expect(room.fileLocked()).toBe(true)
    // The undo key is taken but changes nothing.
    ctrlZ()
    expect(text.toString()).toBe('abc')
  })

  it('is read-only while waiting for the host and editable again once kept', async () => {
    const { room, editor } = await setup()
    go(room, 'connected')
    go(room, 'waiting')
    expect(editable(editor)).toBe(false)
    go(room, 'connected')
    expect(editable(editor)).toBe(true)
    go(room, 'kept')
    expect(room.editLocked()).toBe(false)
    expect(editable(editor)).toBe(true)
  })

  it('keeps a read link read-only through a status change', async () => {
    const { room, editor } = await setup('read')
    go(room, 'waiting')
    go(room, 'connected')
    expect(editable(editor)).toBe(false)
  })

  it('switches files and keeps what the page put in a compartment', async () => {
    const mark = new Compartment()
    const attr = (v: string) => EditorView.contentAttributes.of({ 'data-x': v })
    const { room, editor, files } = await setup('edit', undefined, undefined, (_f, from) => ({
      after: [mark.of((from && mark.get(from)) ?? attr('first'))],
    }))
    expect(editor.view.contentDOM.getAttribute('data-x')).toBe('first')
    editor.view.dispatch({ effects: mark.reconfigure(attr('changed')) })
    const first = files.get(0) as OpenFile
    first.text.insert(0, 'one')
    const second = await secondFile(room, files)
    editor.setFile(second)
    expect(editor.view.state.doc.toString()).toBe('two')
    expect(editor.view.contentDOM.getAttribute('data-x')).toBe('changed')
    // The editable compartment is the core's own and travels the same way.
    go(room, 'closed')
    editor.setFile(first)
    expect(editor.view.state.doc.toString()).toBe('one')
    expect(editable(editor)).toBe(false)
    expect(editor.selection.get()).toEqual({ from: 0, to: 0 })
  })

  it('draws in a shadow root when given one', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const shadow = host.attachShadow({ mode: 'open' })
    const inner = shadow.appendChild(document.createElement('div'))
    const { editor } = await setup('edit', undefined, inner)
    expect(editor.view.root).toBe(shadow)
  })

  it('takes the shadow root from a parent that is in one', async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const shadow = host.attachShadow({ mode: 'open' })
    const { editor } = await setup(
      'edit',
      shadow,
      shadow.appendChild(document.createElement('div')),
    )
    expect(editor.view.root).toBe(shadow)
  })

  it('writes typing to the file and marks the comment threads', async () => {
    const { editor, files } = await setup()
    const text = files.shown.get().text
    editor.view.dispatch({ changes: { from: 0, insert: 'hello world' } })
    expect(text.toString()).toBe('hello world')
    const thread: ShownThread = {
      id: 't1',
      state: 'attached',
      quote: 'world',
      live: '',
      resolved: false,
      messages: [],
      from: 6,
      to: 11,
      cells: null,
      node: null,
    }
    files.threads.set([thread])
    expect(editor.view.dom.querySelector('.cm-comment')?.textContent).toBe('world')
    editor.view.dispatch({ selection: { anchor: 1, head: 4 } })
    expect(editor.selection.get()).toEqual({ from: 1, to: 4 })
    expect(files.target.get()).toEqual({ kind: 'text', from: 1, to: 4 })
  })
})

/** Opens a second file with its own text. */
async function secondFile(room: Room, files: FileSet) {
  const list: FileEntry[] = [
    { id: 0, path: 'a.md', format: 'text' },
    { id: 2, path: 'b.md', format: 'text' },
  ]
  room.hooks.manifest?.(list)
  vi.spyOn(room.client, 'addFile').mockImplementation(() => {})
  Object.defineProperty(room.files, 'get', { value: () => list })
  files.switchTo(2)
  const f = files.get(2)
  if (!f) throw new Error('no second file')
  f.text.insert(0, 'two')
  return f
}
