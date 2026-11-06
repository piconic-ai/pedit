import {
  type Access,
  expiredReason,
  type FileEntry,
  HOST_AWAY,
  ROOM_EXPIRED,
  RoomClient,
  type RoomKeys,
} from '@pedit/protocol'
import { Awareness, editKeys, lowerKeys, Relay, TEST_ROOM, Y } from '@pedit/protocol/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  openRoom,
  type ReviewStatus,
  type Room,
  RoomOpenError,
  reviewStatusOf,
} from '../../src/core/open-room.ts'

const RELAY = new URL('https://relay.test')
const rooms: Room[] = []
const peers: RoomClient[] = []
afterEach(async () => {
  for (const r of rooms.splice(0)) await r.dispose()
  for (const p of peers.splice(0)) await p.destroy()
})

/** Opens a room on `relay` with the link of `access` below `keys`, and connects. */
async function open(
  relay: Relay,
  keys: RoomKeys,
  access: Access = keys.access,
  extra: { fetch?: typeof fetch; connect?: boolean } = {},
): Promise<Room> {
  const fragment = keys.fragments[access]
  if (!fragment) throw new Error('no such link')
  const room = await openRoom({
    relay: RELAY,
    roomId: TEST_ROOM,
    fragment,
    me: { name: 'Guest' },
    createSocket: relay.create,
    fetch: extra.fetch,
  })
  rooms.push(room)
  if (extra.connect !== false) room.connect()
  return room
}

/** Another peer in the room, such as the host, with its awareness state. */
function peer(relay: Relay, keys: RoomKeys, state: Record<string, unknown>) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  awareness.setLocalState(state)
  const client = new RoomClient({
    admissionToken: 'A'.repeat(43),
    url: 'ws://test',
    keys,
    doc,
    awareness,
    createSocket: relay.create,
    minBackoffMs: 1,
  })
  peers.push(client)
  client.connect()
  return client
}

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0,
])

describe('openRoom', () => {
  it('connects to the relay it is given and fetches attachments from it', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const urls: string[] = []
    const fetched = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url))
      return new Response(null, { status: 201 })
    })
    const room = await open(relay, keys, 'edit', { fetch: fetched as typeof fetch })
    expect(relay.urls).toEqual([`wss://relay.test/api/rooms/${TEST_ROOM}/ws`])
    // The host that saves images, as an editor's state says.
    peer(relay, keys, { role: 'host', attachments: { dir: 'assets', maxBytes: 1000 } })
    await vi.waitFor(() => expect(room.attachments.host).not.toBeNull())
    void room.attachments.upload(new Blob([PNG]), 0).catch(() => {})
    await vi.waitFor(() => expect(urls.length).toBeGreaterThan(0))
    expect(urls[0]).toMatch(new RegExp(`^https://relay\\.test/api/rooms/${TEST_ROOM}/blobs/`))
  })

  it('does not connect before connect(), and hooks run in the status order', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const room = await open(relay, keys, 'edit', { connect: false })
    const seen: string[] = []
    room.hooks.status = (s, wasLocked) => seen.push(`status:${s}:${wasLocked}:${room.status.get()}`)
    room.hooks.people = () => seen.push('people')
    room.hooks.reconnected = () => seen.push('reconnected')
    expect(relay.urls).toEqual([])
    room.connect()
    await vi.waitFor(() => expect(room.status.get()).toBe('connected'))
    // People are rendered after the status is set, then the client is told it is back.
    expect(seen[0]).toBe('status:connecting:false:connecting')
    expect(seen.slice(-3)).toEqual(['status:connected:false:connected', 'people', 'reconnected'])
  })

  it('maps statuses to the locks, the away view and the review status', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const room = await open(relay, keys, 'edit', { connect: false })
    const reviews: ReviewStatus[] = []
    room.review.subscribe((r) => reviews.push(r))
    room.connect()
    await vi.waitFor(() => expect(room.status.get()).toBe('connected'))
    expect(room.review.get()).toBe('live')
    expect(room.editLocked()).toBe(false)
    expect(room.fileLocked()).toBe(false)
    expect(room.locked.get()).toBe(false)
    expect(room.away.hostAway.get()).toBe(false)

    relay.signal(HOST_AWAY)
    await vi.waitFor(() => expect(room.status.get()).toBe('waiting'))
    expect(room.review.get()).toBe('host-away')
    expect(room.editLocked()).toBe(true)
    expect(room.fileLocked()).toBe(true)
    expect(room.locked.get()).toBe(true)
    expect(room.away.hostAway.get()).toBe(true)
    expect(room.away.header.get()).toBe('waiting')
    // Published on change only: connecting twice does not repeat.
    expect(reviews).toEqual(['live', 'host-away'])
  })

  it('maps every status to a review status', () => {
    expect(reviewStatusOf('connecting')).toBe('connecting')
    expect(reviewStatusOf('disconnected')).toBe('connecting')
    expect(reviewStatusOf('busy')).toBe('connecting')
    expect(reviewStatusOf('connected')).toBe('live')
    expect(reviewStatusOf('kept')).toBe('host-away')
    expect(reviewStatusOf('log-full')).toBe('host-away')
    expect(reviewStatusOf('closed')).toBe('ended')
    expect(reviewStatusOf('expired')).toBe('ended')
    expect(reviewStatusOf('full')).toBe('ended')
  })

  it('sets the time limit when the relay closes an expired room', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const room = await open(relay, keys)
    await vi.waitFor(() => expect(room.status.get()).toBe('connected'))
    relay.closeAll(ROOM_EXPIRED, expiredReason(86400))
    await vi.waitFor(() => expect(room.status.get()).toBe('expired'))
    expect(room.timeLimit.get()).toBe(86400)
    expect(room.review.get()).toBe('ended')
    expect(room.editLocked()).toBe(true)
  })

  it('ignores a host claim from a peer that cannot edit', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const room = await open(relay, keys)
    const hosts: (Record<string, unknown> | undefined)[] = []
    room.hooks.people = (host) => hosts.push(host)
    const commenter = await lowerKeys(keys, 'comment')
    peer(relay, commenter, {
      user: { name: 'Mallory' },
      role: 'host',
      file: 'evil.md',
      attachments: { dir: 'assets', maxBytes: 1000 },
    })
    await vi.waitFor(() => expect(room.people.get().some((p) => p.name === 'Mallory')).toBe(true))
    expect(room.people.get().some((p) => p.isHost)).toBe(false)
    expect(hosts.at(-1)).toBeUndefined()
    expect(room.attachments.host).toBeNull()
    // An editor's claim speaks for the host.
    peer(relay, keys, { user: { name: 'Host' }, role: 'host', file: 'notes.md' })
    await vi.waitFor(() => expect(hosts.at(-1)?.file).toBe('notes.md'))
    expect(room.people.get().find((p) => p.isHost)?.name).toBe('Host')
  })

  it('takes the list of files into files, and drops a forged comments doc id', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const room = await open(relay, keys)
    const known: FileEntry[][] = []
    room.hooks.manifest = (k) => known.push(k)
    const host = peer(relay, keys, { role: 'host' })
    const list: FileEntry[] = [
      { id: 0, path: 'notes.md', format: 'text' },
      { id: 1, path: '.pedit/meta/notes.md.json', format: 'meta' },
      { id: 2, path: 'later.md', format: 'text' },
      { id: 3, path: 'x', format: 'hologram' },
    ]
    host.setManifest(list)
    await vi.waitFor(() => expect(room.files.get().length).toBeGreaterThan(0))
    // Formats this version does not know, and the metadata, are left out.
    expect(room.files.get().map((f) => f.id)).toEqual([0, 2])
    expect(known.at(-1)).toEqual(room.files.get())
    expect([...room.metaOf]).toEqual([[0, 1]])
    expect(room.formats.get(2)).toBe('text')
    // The comments doc was joined under id 1; opening a file there lets it go.
    expect(room.commentDocs.docFor(1)).not.toBeNull()
    expect(room.commentDocs.takeForFile(1)).toBe(true)
    expect(room.commentDocs.docFor(1)).toBeNull()
    // A later list that names no comments leaves none of them.
    host.setManifest([{ id: 0, path: 'notes.md', format: 'text' }])
    await vi.waitFor(() => expect(room.metaOf.size).toBe(0))
    expect(room.files.get().map((f) => f.id)).toEqual([0])
  })

  it('gives a read link read-only access', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const room = await open(relay, keys, 'read')
    expect(room.access).toBe('read')
    expect(room.writesFile).toBe(false)
    expect(room.writesComments).toBe(false)
    expect(room.locked.get()).toBe(true)
    expect(room.fileLocked()).toBe(true)
    expect(room.commentsLocked()).toBe(true)
    expect(room.noImages()).toBe('This link cannot add images.')
    // A comment link comments, but writes no file.
    const commenting = await open(relay, keys, 'comment')
    expect(commenting.writesFile).toBe(false)
    expect(commenting.writesComments).toBe(true)
    expect(commenting.locked.get()).toBe(false)
  })

  it('rejects a bad fragment with a typed error', async () => {
    const attempt = openRoom({
      relay: RELAY,
      roomId: TEST_ROOM,
      fragment: 'not a key',
      me: { name: 'Guest' },
    })
    await expect(attempt).rejects.toBeInstanceOf(RoomOpenError)
    await expect(attempt).rejects.toMatchObject({ reason: 'bad-link' })
  })

  it('reports a browser that cannot check signatures', async () => {
    const keys = await editKeys()
    const spy = vi.spyOn(crypto.subtle, 'importKey').mockRejectedValue(new Error('no Ed25519'))
    try {
      const fragment = keys.fragments.edit as string
      await expect(
        openRoom({ relay: RELAY, roomId: TEST_ROOM, fragment, me: { name: 'Guest' } }),
      ).rejects.toMatchObject({ reason: 'unsupported-browser' })
    } finally {
      spy.mockRestore()
    }
  })

  it('destroys the client and stops listening on dispose()', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const room = await open(relay, keys)
    await vi.waitFor(() => expect(room.status.get()).toBe('connected'))
    await vi.waitFor(() => expect(room.people.get().some((p) => p.isSelf)).toBe(true))
    const calls: string[] = []
    const off = vi.spyOn(room.awareness, 'off')
    const destroy = vi.spyOn(room.awareness, 'destroy').mockImplementation(() => {
      calls.push('destroy')
    })
    off.mockImplementation(((name: string) => {
      calls.push(`off:${name}`)
    }) as typeof room.awareness.off)
    await room.dispose()
    expect(room.client.status).toBe('disconnected')
    expect(relay.sockets.size).toBe(0)
    // Both listeners come off, before the awareness is destroyed.
    expect(calls.slice(-3)).toEqual(['off:change', 'off:change', 'destroy'])
    // The client's own state went while the people were still followed.
    expect(room.people.get().some((p) => p.isSelf)).toBe(false)
    destroy.mockRestore()
    off.mockRestore()
  })

  it('keeps the status as it was when it leaves', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const live = await open(relay, keys)
    await vi.waitFor(() => expect(live.review.get()).toBe('live'))
    const seen: ReviewStatus[] = []
    live.review.subscribe((r) => seen.push(r))
    await live.dispose()
    expect(live.review.get()).toBe('live')
    expect(live.status.get()).toBe('connected')
    expect(live.locked.get()).toBe(false)
    expect(seen).toEqual([])

    const ended = await open(relay, keys)
    await vi.waitFor(() => expect(ended.status.get()).toBe('connected'))
    relay.closeAll(ROOM_EXPIRED, expiredReason(86400))
    await vi.waitFor(() => expect(ended.review.get()).toBe('ended'))
    await ended.dispose()
    expect(ended.review.get()).toBe('ended')
    expect(ended.status.get()).toBe('expired')
    expect(ended.editLocked()).toBe(true)
  })

  it('sends an attachment about the file on screen unless told otherwise', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const fetched = vi.fn(async () => new Response(null, { status: 201 }))
    const room = await open(relay, keys, 'edit', { fetch: fetched as unknown as typeof fetch })
    peer(relay, keys, { role: 'host', attachments: { dir: 'assets', maxBytes: 1000 } })
    await vi.waitFor(() => expect(room.attachments.host).not.toBeNull())
    const toRoom = vi.spyOn(room.client, 'sendAttachment')
    const toFile = vi.spyOn(room.client, 'sendFileAttachment')
    room.current.set(2)
    void room.attachments.upload(new Blob([PNG])).catch(() => {})
    await vi.waitFor(() => expect(toFile).toHaveBeenCalled())
    expect(toFile.mock.calls[0]?.[0]).toBe(2)
    expect(toRoom).not.toHaveBeenCalled()
    // With the room's own doc on screen, the room's own client sends it.
    const second = await open(relay, keys, 'edit', { fetch: fetched as unknown as typeof fetch })
    await vi.waitFor(() => expect(second.attachments.host).not.toBeNull())
    const toOwn = vi.spyOn(second.client, 'sendAttachment')
    void second.attachments.upload(new Blob([PNG])).catch(() => {})
    await vi.waitFor(() => expect(toOwn).toHaveBeenCalled())
  })

  it('follows what the relay says of kept comments', async () => {
    const relay = new Relay({ protocol: 'pedit-v8' })
    const keys = await editKeys()
    const room = await open(relay, keys, 'comment')
    await vi.waitFor(() => expect(room.status.get()).toBe('connected'))
    relay.signal('kept 1700000000000')
    await vi.waitFor(() => expect(room.status.get()).toBe('kept'))
    // A comment link cannot comment in a kept room until the relay takes comments.
    expect(room.locked.get()).toBe(true)
    expect(room.away.keeps.get()).toBeNull()
    relay.signal('kept comments')
    await vi.waitFor(() => expect(room.locked.get()).toBe(false))
    expect(room.away.keeps.get()).toBe('comments')
  })

  it('routes canvas messages to the hook with the file they are about', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const room = await open(relay, keys)
    const got: [number, unknown][] = []
    room.hooks.canvas = (file, m) => got.push([file, m])
    const host = peer(relay, keys, { role: 'host' })
    await vi.waitFor(() => expect(host.status).toBe('connected'))
    host.sendCanvas({ kind: 'applied', id: 'a' })
    await vi.waitFor(() => expect(got).toContainEqual([0, { kind: 'applied', id: 'a' }]))
    host.sendFileCanvas(3, { kind: 'applied', id: 'b' })
    await vi.waitFor(() => expect(got).toContainEqual([3, { kind: 'applied', id: 'b' }]))
  })

  it('takes awareness changes before connect() with no hooks, then tells the hook', async () => {
    const relay = new Relay()
    const keys = await editKeys()
    const room = await open(relay, keys, 'edit', { connect: false })
    expect(() => room.awareness.setLocalStateField('file', 1)).not.toThrow()
    expect(room.people.get().some((p) => p.isSelf)).toBe(true)
    const people = vi.fn()
    room.hooks.people = people
    room.connect()
    expect(people).toHaveBeenCalled()
  })
})
