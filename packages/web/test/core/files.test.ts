import { type CanvasMessage, type FileEntry, RoomClient, type RoomKeys } from '@pedit/protocol'
import { Awareness, editKeys, Relay, TEST_ROOM, Y } from '@pedit/protocol/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSet, type FileView, type OpenFile } from '../../src/core/files.ts'
import { openRoom, type Room } from '../../src/core/open-room.ts'

const rooms: Room[] = []
const peers: RoomClient[] = []
afterEach(async () => {
  for (const r of rooms.splice(0)) await r.dispose()
  for (const p of peers.splice(0)) await p.destroy()
})

const NOTES: FileEntry = { id: 0, path: 'notes.md', format: 'text' }
const LATER: FileEntry = { id: 2, path: 'later.md', format: 'text' }
const meta = (id: number, of: string): FileEntry => ({
  id,
  path: `.pedit/meta/${of}.json`,
  format: 'meta',
})

async function setup(access: 'edit' | 'read' = 'edit') {
  const relay = new Relay()
  const keys: RoomKeys = await editKeys()
  const fragment = keys.fragments[access] as string
  const room = await openRoom({
    relay: new URL('https://relay.test'),
    roomId: TEST_ROOM,
    fragment,
    me: { name: 'Guest' },
    createSocket: relay.create,
  })
  rooms.push(room)
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalState({ role: 'host' })
  const host = new RoomClient({
    admissionToken: 'A'.repeat(43),
    url: 'ws://test',
    keys,
    doc,
    awareness,
    createSocket: relay.create,
    minBackoffMs: 1,
  })
  peers.push(host)
  host.connect()
  const files = new FileSet(room, {
    name: 'Guest',
    textTarget: () => ({ kind: 'text', from: 0, to: 0 }),
  })
  return { room, files, host }
}

/** A view that records what it was told. */
function fake(log: string[], over: Partial<FileView> = {}) {
  return (f: OpenFile): FileView => ({
    setStatus: (s, canWrite) => log.push(`${f.id}:${s}:${canWrite}`),
    canvas: (m) => log.push(`${f.id}:canvas:${m.kind}`),
    reconnected: () => log.push(`${f.id}:reconnected`),
    ...over,
  })
}

const list = (...entries: FileEntry[]) => entries

describe('FileSet', () => {
  it('opens a second file in a doc of its own and follows its comments', async () => {
    const { room, files, host } = await setup()
    room.connect()
    host.setManifest(list(NOTES, meta(1, 'later.md'), LATER, meta(3, 'notes.md')))
    await vi.waitFor(() => expect(room.files.get().length).toBe(2))
    expect(files.get(2)).toBeUndefined()
    const add = vi.spyOn(room.client, 'addFile')
    const entry = files.switchTo(2)
    expect(entry).toEqual(LATER)
    const f = files.get(2) as OpenFile
    expect(f.doc).not.toBe(room.doc)
    expect(add).toHaveBeenCalledWith(2, f.doc)
    expect(f.comments).not.toBeNull()
    expect(f.commentsMeta).toBe(1)
    expect(files.comments.get()).toBe(f.comments)
    expect(files.commentable.get()).toBe(true)
    // The first file follows its comments too, once the list names them.
    expect(files.get(0)?.commentsMeta).toBe(3)
  })

  it('refollows when a manifest moves the meta id, and stops when it drops it', async () => {
    const { room, files, host } = await setup()
    room.connect()
    host.setManifest(list(NOTES, meta(1, 'notes.md')))
    await vi.waitFor(() => expect(files.get(0)?.comments).not.toBeNull())
    const old = files.get(0)?.comments as NonNullable<OpenFile['comments']>
    const destroy = vi.spyOn(old, 'destroy')
    host.setManifest(list(NOTES, meta(5, 'notes.md')))
    await vi.waitFor(() => expect(files.get(0)?.commentsMeta).toBe(5))
    expect(destroy).toHaveBeenCalled()
    const now = files.get(0)?.comments
    expect(now).not.toBeNull()
    expect(now).not.toBe(old)
    expect(files.comments.get()).toBe(now)
    host.setManifest(list(NOTES))
    await vi.waitFor(() => expect(files.get(0)?.comments).toBeNull())
    expect(files.comments.get()).toBeNull()
    expect(files.commentable.get()).toBe(false)
  })

  it('switchTo puts the file on screen and tells the room', async () => {
    const { room, files, host } = await setup()
    room.connect()
    host.setManifest(list(NOTES, LATER))
    await vi.waitFor(() => expect(room.files.get().length).toBe(2))
    const hidden: number[] = []
    files.addView((f) => ({ hide: () => hidden.push(f.id) }))
    expect(files.switchTo(0)).toBeNull()
    expect(files.switchTo(9)).toBeNull()
    files.switchTo(2)
    expect(files.shown.get().id).toBe(2)
    expect(room.current.get()).toBe(2)
    expect(room.awareness.getLocalState()?.file).toBe(2)
    expect(hidden).toEqual([0])
    files.switchTo(0)
    expect(files.shown.get()).toBe(files.get(0))
    expect(room.current.get()).toBe(0)
    expect(hidden).toEqual([0, 2])
  })

  it('takes the comment target from the active view, else the text', async () => {
    const { room, files } = await setup()
    let active: 'node' | 'none' = 'none'
    files.addView(() => ({
      target: () => (active === 'node' ? { kind: 'node', id: 'n1' } : undefined),
    }))
    files.aim()
    expect(files.target.get()).toEqual({ kind: 'text', from: 0, to: 0 })
    active = 'node'
    files.aim()
    expect(files.target.get()).toEqual({ kind: 'node', id: 'n1' })
    // A view says the target changed through the file it was made for.
    active = 'none'
    files.shown.get().aim()
    expect(files.target.get()).toEqual({ kind: 'text', from: 0, to: 0 })
    expect(room.current.get()).toBe(0)
  })

  it('keeps an active view without a selection from falling back to the text', async () => {
    const { files } = await setup()
    // A table on screen with no cell selected, while the hidden editor has a selection.
    let active = false
    files.addView(() => ({ target: () => (active ? null : undefined) }))
    files.aim()
    expect(files.target.get()).toEqual({ kind: 'text', from: 0, to: 0 })
    active = true
    files.aim()
    expect(files.target.get()).toBeNull()
  })

  it('tells every open file its views of a status, with whether the link writes', async () => {
    const { room, files, host } = await setup()
    host.setManifest(list(NOTES, LATER))
    room.connect()
    await vi.waitFor(() => expect(room.files.get().length).toBe(2))
    const log: string[] = []
    files.addView(fake(log))
    files.switchTo(2)
    // A view hears of the status as it is made.
    expect(log.slice(0, 2)).toEqual([`0:${room.status.get()}:true`, `2:${room.status.get()}:true`])
    log.length = 0
    room.hooks.status?.('closed', false)
    expect(log).toEqual(['0:closed:true', '2:closed:true'])
  })

  it('passes the end of the room to the views as final, and a read link as unable to write', async () => {
    const { room, files } = await setup('read')
    const log: string[] = []
    files.addView(fake(log))
    log.length = 0
    room.hooks.status?.('closed', false)
    room.hooks.status?.('connected', false)
    expect(log).toEqual(['0:closed:false', '0:connected:false'])
  })

  it('hands canvas messages and reconnects to the right file', async () => {
    const { room, files, host } = await setup()
    host.setManifest(list(NOTES, LATER))
    room.connect()
    await vi.waitFor(() => expect(room.files.get().length).toBe(2))
    const log: string[] = []
    files.addView(fake(log))
    files.switchTo(2)
    log.length = 0
    const m: CanvasMessage = { kind: 'applied', id: 'e1' }
    room.hooks.canvas?.(2, m)
    room.hooks.canvas?.(7, m)
    room.hooks.canvas?.(0, m)
    expect(log).toEqual(['2:canvas:applied', '0:canvas:applied'])
    log.length = 0
    room.hooks.reconnected?.()
    expect(log).toEqual(['0:reconnected', '2:reconnected'])
  })

  it('runs the page hooks after the files', async () => {
    const { room } = await setup()
    const order: string[] = []
    const files = new FileSet(room, {
      name: 'Guest',
      textTarget: () => null,
      onStatus: () => order.push('page'),
    })
    files.addView(() => ({ setStatus: () => order.push('view') }))
    order.length = 0
    room.hooks.status?.('closed', false)
    expect(order).toEqual(['view', 'page'])
  })

  it('disposes the comments and views, and takes no more from the room', async () => {
    const { room, files, host } = await setup()
    const gone = vi.fn()
    files.addView(() => ({ dispose: gone }))
    room.connect()
    host.setManifest(list(NOTES, meta(1, 'notes.md')))
    await vi.waitFor(() => expect(files.get(0)?.comments).not.toBeNull())
    files.dispose()
    expect(files.get(0)?.comments).toBeNull()
    expect(files.comments.get()).toBeNull()
    expect(files.commentable.get()).toBe(false)
    expect(gone).toHaveBeenCalledOnce()
    // A list that comes now follows nothing.
    host.setManifest(list(NOTES, meta(4, 'notes.md')))
    await vi.waitFor(() => expect(room.metaOf.get(0)).toBe(4))
    expect(files.get(0)?.comments).toBeNull()
  })

  it('hears nothing from a room that was left', async () => {
    const { room, files, host } = await setup()
    const log: string[] = []
    files.addView(fake(log))
    room.connect()
    host.setManifest(list(NOTES, meta(1, 'notes.md')))
    await vi.waitFor(() => expect(files.get(0)?.comments).not.toBeNull())
    await room.dispose()
    log.length = 0
    files.dispose()
    host.setManifest(list(NOTES, meta(6, 'notes.md')))
    await new Promise((r) => setTimeout(r, 50))
    expect(files.get(0)?.comments).toBeNull()
    expect(log).toEqual([])
  })

  it('refuses a view once comments are followed', async () => {
    const { room, files, host } = await setup()
    room.connect()
    host.setManifest(list(NOTES, meta(1, 'notes.md')))
    await vi.waitFor(() => expect(files.get(0)?.comments).not.toBeNull())
    expect(() => files.addView(() => ({}))).toThrow(/before comments are followed/)
  })

  it('marks threads only in the views of the file on screen', async () => {
    const { room, files, host } = await setup()
    const seen: string[] = []
    files.addView((f) => ({ commented: () => seen.push(`${f.id}`) }))
    room.connect()
    host.setManifest(list(NOTES, meta(1, 'notes.md'), LATER, meta(3, 'later.md')))
    await vi.waitFor(() => expect(files.get(0)?.comments).not.toBeNull())
    files.switchTo(2)
    await vi.waitFor(() => expect(files.get(2)?.comments).not.toBeNull())
    seen.length = 0
    files.shown.get().comments?.refresh()
    files.switchTo(0)
    expect(seen.every((id) => id === '0' || id === '2')).toBe(true)
    expect(seen.at(-1)).toBe('0')
    seen.length = 0
    files.switchTo(2)
    expect(seen).toEqual(['2'])
  })

  it('leaves the target alone when a hidden file aims', async () => {
    const { room, files, host } = await setup()
    host.setManifest(list(NOTES, LATER))
    room.connect()
    await vi.waitFor(() => expect(room.files.get().length).toBe(2))
    let node = 'a'
    files.addView(() => ({ target: () => ({ kind: 'node', id: node }) }))
    files.aim()
    const other = files.open(LATER)
    node = 'b'
    other.aim()
    expect(files.target.get()).toEqual({ kind: 'node', id: 'a' })
    files.shown.get().aim()
    expect(files.target.get()).toEqual({ kind: 'node', id: 'b' })
  })

  it('gives the comments the anchors of the views', async () => {
    const { room, files, host } = await setup()
    files.addView(() => ({ anchors: { nodes: () => new Map([['g1', 'Goal']]) } }))
    room.connect()
    await vi.waitFor(() => expect(room.status.get()).toBe('connected'))
    host.setManifest(
      list(
        NOTES,
        meta(1, 'notes.md'),
        { id: 2, path: 'board.canvas', format: 'canvas' },
        meta(3, 'board.canvas'),
      ),
    )
    await vi.waitFor(() => expect(room.files.get().length).toBe(2))
    files.switchTo(2)
    const canvas = files.get(2)?.comments
    expect(canvas?.startOn({ kind: 'node', id: 'g1' }, 'Scope')).not.toBeNull()
    expect(canvas?.startOn({ kind: 'node', id: 'nope' }, 'Scope')).toBeNull()
    // A text file takes none of them.
    expect(files.get(0)?.comments?.startOn({ kind: 'node', id: 'g1' }, 'Scope')).toBeNull()
  })
})
