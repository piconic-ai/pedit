import 'fake-indexeddb/auto'
import { parseKeptFragment } from '@pedit/protocol/kept-access'
import { KeptOutbox } from '@pedit/protocol/kept-outbox'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import access from '../../testdata/kept-access-vectors.json'
import { KeptCommentController, type KeptCommentStatus } from '../src/kept-comment-controller.ts'

function fixtureLink() {
  const value = parseKeptFragment(access.comment)
  if (!value || value.access !== 'comment') throw new Error('fixture')
  return value
}
const link = fixtureLink()
const roomId = 'AAECAwQFBgcICQoLDA0ODw'
const context = { roomId, epoch: new Uint8Array(32).fill(3), generation: 1 }
const active = new Set<string>()
const locks = {
  request: async (
    name: string,
    _options: unknown,
    callback: (lock: object | null) => Promise<void>,
  ) => {
    if (active.has(name)) return callback(null)
    active.add(name)
    try {
      await callback({})
    } finally {
      active.delete(name)
    }
  },
} as unknown as LockManager
async function setup() {
  const outbox = await KeptOutbox.open(`comment-${crypto.randomUUID()}`)
  const sender = await outbox.createSender(link, roomId)
  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'hello world')
  const meta = new Y.Doc()
  let status: KeptCommentStatus = 'idle'
  const options = {
    url: 'https://example.test',
    link,
    context,
    sender,
    outbox,
    metaId: 7,
    text: Y.encodeStateAsUpdate(doc),
    comments: Y.encodeStateAsUpdate(meta),
    locks,
    name: () => 'Ada',
    onStatus: (value: KeptCommentStatus) => {
      status = value
    },
    fetch: async () => {
      throw new Error('offline')
    },
  }
  doc.destroy()
  meta.destroy()
  return { outbox, sender, options, status: () => status }
}
function comments(state: Uint8Array): Record<string, unknown> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const json = doc.getMap('comments').toJSON()
  doc.destroy()
  return json
}
it('persists comments and replies before exposing them, and restores after reopening', async () => {
  const { outbox, sender, options } = await setup()
  const editor = await KeptCommentController.open(options)
  const enqueue = outbox.enqueue.bind(outbox)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((r) => {
      release = r
    }),
    waiting = new Promise<void>((r) => {
      entered = r
    })
  outbox.enqueue = async (...args) => {
    entered()
    await gate
    return enqueue(...args)
  }
  const pending = editor.start(0, 5, 'hello')
  await waiting
  expect(comments(editor.commentState())).toEqual({})
  release()
  const id = await pending
  expect(comments(editor.commentState())).toHaveProperty(id)
  await editor.reply(id, 'reply')
  await editor.close()
  expect(await outbox.operations(link, roomId, sender)).toHaveLength(2)
  const reopened = await KeptCommentController.open(options)
  expect(comments(reopened.commentState())).toEqual(comments(editor.commentState()))
  await reopened.close()
  outbox.close()
})
it('does not expose a failed write and permits retry', async () => {
  const { outbox, sender, options, status } = await setup()
  const editor = await KeptCommentController.open(options)
  const enqueue = outbox.enqueue.bind(outbox)
  outbox.enqueue = async () => {
    throw new Error('disk')
  }
  await expect(editor.start(0, 5, 'draft')).rejects.toThrow('disk')
  expect(comments(editor.commentState())).toEqual({})
  expect(status()).toBe('failed')
  expect(await outbox.operations(link, roomId, sender)).toHaveLength(0)
  outbox.enqueue = enqueue
  await editor.start(0, 5, 'draft')
  await editor.close()
  outbox.close()
})
it('persists typed remote text and comments, then restores a dependent comment', async () => {
  const { outbox, options } = await setup()
  const editor = await KeptCommentController.open(options)
  const remote = new Y.Doc()
  Y.applyUpdate(remote, options.text)
  const vector = Y.encodeStateVector(remote)
  remote.getText('content').insert(5, ' remote')
  await editor.applyRemote('text', Y.encodeStateAsUpdate(remote, vector))
  await editor.start(0, 5, 'hello')
  const before = comments(editor.commentState())
  await editor.close()
  const reopened = await KeptCommentController.open(options)
  expect(comments(reopened.commentState())).toEqual(before)
  const restored = new Y.Doc()
  Y.applyUpdate(restored, reopened.textState())
  expect(restored.getText('content').toString()).toBe('hello remote world')
  await reopened.close()
  restored.destroy()
  remote.destroy()
  outbox.close()
})
it('rejects second writer and wrong access', async () => {
  const { outbox, options } = await setup()
  const editor = await KeptCommentController.open(options)
  await expect(KeptCommentController.open(options)).rejects.toThrow('already open')
  await editor.close()
  outbox.close()
})
it('restores a local reply that depends on a persisted remote comment', async () => {
  const { outbox, options } = await setup()
  const editor = await KeptCommentController.open(options)
  const text = new Y.Doc()
  Y.applyUpdate(text, options.text)
  const meta = new Y.Doc()
  Y.applyUpdate(meta, options.comments)
  const before = Y.encodeStateVector(meta)
  const { CommentsView } = await import('../src/comments.ts')
  const view = new CommentsView(meta, text, { name: () => 'remote' })
  const thread = view.start(0, 5, 'remote comment')
  if (!thread) throw new Error('fixture')
  await editor.applyRemote('comments', Y.encodeStateAsUpdate(meta, before))
  await editor.reply(thread, 'local reply')
  const expected = comments(editor.commentState())
  await editor.close()
  const reopened = await KeptCommentController.open(options)
  expect(comments(reopened.commentState())).toEqual(expected)
  await reopened.close()
  view.destroy()
  text.destroy()
  meta.destroy()
  outbox.close()
})
it('rejects malformed and unsupported remote data before persistence', async () => {
  const { outbox, sender, options } = await setup()
  const editor = await KeptCommentController.open(options)
  const bad = new Y.Doc()
  bad.getMap('other').set('x', 1)
  await expect(editor.applyRemote('comments', Y.encodeStateAsUpdate(bad))).rejects.toThrow()
  expect((await outbox.recoveryState(link, roomId, sender)).remote).toHaveLength(0)
  expect(comments(editor.commentState())).toEqual({})
  bad.destroy()
  await editor.close()
  outbox.close()
})
it('rejects read access and an invalid metadata id', async () => {
  const { outbox, options } = await setup()
  const read = parseKeptFragment(access.read)
  if (!read) throw new Error('fixture')
  await expect(
    KeptCommentController.open({ ...options, link: read as typeof options.link }),
  ).rejects.toThrow('access')
  await expect(KeptCommentController.open({ ...options, metaId: 0 })).rejects.toThrow('access')
  outbox.close()
})
it('does not apply remote data if strict persistence fails', async () => {
  const { outbox, options } = await setup()
  const editor = await KeptCommentController.open(options)
  const remote = new Y.Doc()
  Y.applyUpdate(remote, options.text)
  const vector = Y.encodeStateVector(remote)
  remote.getText('content').insert(0, 'remote')
  outbox.saveRemote = async () => {
    throw new Error('storage')
  }
  await expect(editor.applyRemote('text', Y.encodeStateAsUpdate(remote, vector))).rejects.toThrow(
    'storage',
  )
  const current = new Y.Doc()
  Y.applyUpdate(current, editor.textState())
  expect(current.getText('content').toString()).toBe('hello world')
  await editor.close()
  current.destroy()
  remote.destroy()
  outbox.close()
})
it('rejects an outbox operation for another metadata id', async () => {
  const { outbox, sender, options } = await setup()
  const { encodeFileDoc, encodeMessage, MessageType } = await import('@pedit/protocol')
  const encoding = await import('lib0/encoding')
  const sync = await import('y-protocols/sync')
  const meta = new Y.Doc()
  const e = encoding.createEncoder()
  sync.writeUpdate(e, Y.encodeStateAsUpdate(meta))
  await outbox.enqueue(
    link,
    roomId,
    sender,
    encodeMessage(MessageType.Files, encodeFileDoc(8, MessageType.Sync, encoding.toUint8Array(e))),
  )
  await expect(KeptCommentController.open(options)).rejects.toThrow('metadata')
  meta.destroy()
  outbox.close()
})
it('close waits for an in-flight durable comment before releasing its writer', async () => {
  const { outbox, options } = await setup()
  const editor = await KeptCommentController.open(options)
  const enqueue = outbox.enqueue.bind(outbox)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>((r) => {
      release = r
    }),
    waiting = new Promise<void>((r) => {
      entered = r
    })
  outbox.enqueue = async (...args) => {
    entered()
    await gate
    return enqueue(...args)
  }
  const pending = editor.start(0, 5, 'pending')
  await waiting
  const closing = editor.close()
  await expect(KeptCommentController.open(options)).rejects.toThrow('already open')
  release()
  await pending
  await closing
  const reopened = await KeptCommentController.open(options)
  expect(JSON.stringify(comments(reopened.commentState()))).toContain('pending')
  await reopened.close()
  outbox.close()
})
it('does not report relay acceptance over a later failed local comment', async () => {
  const { outbox, options, status } = await setup()
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>((r) => {
      entered = r
    }),
    gate = new Promise<void>((r) => {
      release = r
    })
  const editor = await KeptCommentController.open({
    ...options,
    fetch: async () => {
      entered()
      await gate
      return new Response('{"sequence":1}', { status: 200 })
    },
  })
  const id = await editor.start(0, 5, 'first')
  await waiting
  outbox.enqueue = async () => {
    throw new Error('storage')
  }
  await expect(editor.reply(id, 'unsaved')).rejects.toThrow('storage')
  release()
  await editor.retry()
  expect(status()).toBe('failed')
  await editor.close()
  outbox.close()
})
it('rejects selections that split a Unicode surrogate pair', async () => {
  const { outbox, options } = await setup()
  const text = new Y.Doc()
  text.getText('content').insert(0, 'a😀b')
  const editor = await KeptCommentController.open({ ...options, text: Y.encodeStateAsUpdate(text) })
  await expect(editor.start(1, 2, 'bad')).rejects.toThrow('range')
  expect(comments(editor.commentState())).toEqual({})
  await editor.close()
  text.destroy()
  outbox.close()
})
it('review: anchors survive repeated remote update and reopen', async () => {
  const { outbox, sender, options } = await setup()
  const editor = await KeptCommentController.open(options)
  const remote = new Y.Doc()
  Y.applyUpdate(remote, options.text)
  const vector = Y.encodeStateVector(remote)
  remote.getText('content').insert(0, 'prefix ')
  const update = Y.encodeStateAsUpdate(remote, vector)
  await editor.applyRemote('text', update)
  await editor.applyRemote('text', update)
  const id = await editor.start(7, 12, 'anchored')
  await editor.close()
  const reopened = await KeptCommentController.open(options)
  const text = new Y.Doc()
  Y.applyUpdate(text, reopened.textState())
  const meta = new Y.Doc()
  Y.applyUpdate(meta, reopened.commentState())
  const thread = meta.getMap('comments').get(id) as Y.Map<unknown>
  const anchor = thread.get('anchor') as { start: string; end: string }
  const resolve = (s: string) =>
    Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))),
      text,
    )?.index
  expect([resolve(anchor.start), resolve(anchor.end)]).toEqual([7, 12])
  expect((await outbox.recoveryState(link, roomId, sender)).remote).toHaveLength(1)
  await reopened.close()
  text.destroy()
  meta.destroy()
  remote.destroy()
  outbox.close()
})
