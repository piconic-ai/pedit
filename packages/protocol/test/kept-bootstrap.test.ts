import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import fixture from '../../testdata/kept-read-interop.json'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { openKeptCheckpoint } from '../src/kept-checkpoint.ts'
import { KeptOutbox } from '../src/kept-outbox.ts'
import type { KeptReadInspection } from '../src/kept-room-client.ts'
import { decodeKeptTextPayload } from '../src/kept-text-payload.ts'
import { TestBootstrapCoordinator, testLockManager } from './kept-bootstrap-coordinator.ts'

const bytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
async function setup() {
  const edit = parseKeptFragment(fixture.fragment)!
  if (edit.access !== 'edit') throw Error('fixture')
  const keys = await deriveKeptRoomKeys(edit, fixture.roomId)
  const comment = parseKeptFragment(keys.fragments.comment ?? '')!
  if (comment.access !== 'comment') throw Error('fixture')
  const epoch = Uint8Array.from(fixture.epoch.match(/../g)!, (v) => parseInt(v, 16))
  const context = { roomId: fixture.roomId, epoch, generation: 1, cutoff: 0 }
  const ciphertext = bytes(fixture.checkpoint)
  const decoded = decodeKeptTextPayload(await openKeptCheckpoint(keys, context, ciphertext), 10000)
  const metadataId = decoded.manifest.find((f) => f.format === 'meta')!.id
  const text = decoded.documents.get(0)!,
    comments = decoded.documents.get(metadataId)!
  const doc = new Y.Doc()
  Y.applyUpdate(doc, text)
  doc.getText('content').insert(doc.getText('content').length, ' remote')
  const read: KeptReadInspection = {
    checkpoint: {
      kind: 'authenticated-checkpoint',
      context,
      metadataId,
      ciphertext,
      textState: text,
      commentsState: comments,
    },
    status: 'tail-unverified',
    applicable: false,
    generation: 1,
    tail: 1,
    records: 1,
    textState: Y.encodeStateAsUpdate(doc),
    commentsState: comments,
  }
  doc.destroy()
  const locks = testLockManager()
  const name = `bootstrap-${crypto.randomUUID()}`
  const outbox = await KeptOutbox.open(name)
  const editSender = await outbox.createSender(edit, fixture.roomId),
    commentSender = await outbox.createSender(comment, fixture.roomId)
  return { edit, comment, read, outbox, name, editSender, commentSender, locks }
}
it('resumes strict partial dependency capture and blocks old operations on context change', async () => {
  const { edit, comment, read, outbox, name, editSender, commentSender, locks } = await setup()
  const save = outbox.saveRemote.bind(outbox)
  let fail = true
  outbox.saveRemote = async (...args) => {
    if (args[0].access === 'comment' && args[3][0] === 2 && fail) {
      fail = false
      throw Error('storage')
    }
    return save(...args)
  }
  const base = {
    outbox,
    edit,
    comment,
    editSender,
    commentSender,
    locks,
    url: 'https://example.test',
    fetch: async () => new Response('{"sequence":1}', { status: 200 }),
  }
  await expect(TestBootstrapCoordinator.start({ ...base, read })).rejects.toThrow('storage')
  expect((await outbox.bootstrapState(edit, fixture.roomId, editSender)).ready).toBe(false)
  expect((await outbox.bootstrapState(comment, fixture.roomId, commentSender)).ready).toBe(false)
  await expect(outbox.enqueue(edit, fixture.roomId, editSender, Uint8Array.of(1))).rejects.toThrow(
    'incomplete',
  )
  await expect(
    outbox.enqueue(comment, fixture.roomId, commentSender, Uint8Array.of(1)),
  ).rejects.toThrow('incomplete')
  await expect(
    outbox.prepare(
      edit,
      { roomId: fixture.roomId, epoch: read.checkpoint.context.epoch, generation: 1 },
      editSender,
      1,
    ),
  ).rejects.toThrow('incomplete')
  outbox.close()
  const reopened = await KeptOutbox.open(name)
  const coordinator = await TestBootstrapCoordinator.resume({
    ...base,
    outbox: reopened,
    roomId: fixture.roomId,
  })
  expect((await reopened.bootstrapState(edit, fixture.roomId, editSender)).ready).toBe(true)
  expect((await reopened.bootstrapState(comment, fixture.roomId, commentSender)).ready).toBe(true)
  await coordinator.enqueue('edit', Uint8Array.of(1))
  await expect(
    reopened.prepare(
      edit,
      { roomId: fixture.roomId, epoch: new Uint8Array(32).fill(9), generation: 1 },
      editSender,
      1,
    ),
  ).rejects.toThrow('epoch changed')
  await expect(
    reopened.prepare(
      edit,
      { roomId: fixture.roomId, epoch: read.checkpoint.context.epoch, generation: 2 },
      editSender,
      1,
    ),
  ).rejects.toThrow('epoch changed')
  expect((await reopened.operations(edit, fixture.roomId, editSender))[0]?.acknowledged).toBe(false)
  await coordinator.close()
  reopened.close()
})
it('rejects tampered checkpoint binding or candidate before staging', async () => {
  const { edit, read, outbox, editSender, commentSender } = await setup()
  await expect(
    outbox.stageBootstrap(
      edit,
      { ...read.checkpoint, metadataId: read.checkpoint.metadataId + 1 },
      { textState: read.textState, commentsState: read.commentsState },
      editSender,
      { editSender, commentSender },
    ),
  ).rejects.toThrow()
  const ciphertext = Uint8Array.from(read.checkpoint.ciphertext)
  ciphertext[ciphertext.length - 1] = ciphertext[ciphertext.length - 1]! ^ 1
  await expect(
    outbox.stageBootstrap(
      edit,
      { ...read.checkpoint, ciphertext },
      { textState: read.textState, commentsState: read.commentsState },
      editSender,
      { editSender, commentSender },
    ),
  ).rejects.toThrow()
  const other = new Y.Doc()
  other.getText('content').insert(0, 'not a descendant')
  await expect(
    outbox.stageBootstrap(
      edit,
      read.checkpoint,
      { textState: Y.encodeStateAsUpdate(other), commentsState: read.commentsState },
      editSender,
      { editSender, commentSender },
    ),
  ).rejects.toThrow()
  await expect(outbox.bootstrapState(edit, fixture.roomId, editSender)).rejects.toThrow()
  other.destroy()
  outbox.close()
})
it('sends text before comments and never advances comments after a text failure', async () => {
  const { edit, comment, read, outbox, editSender, commentSender, locks } = await setup()
  const keys = await deriveKeptRoomKeys(edit, fixture.roomId)
  const sent: { tier: string; body: Uint8Array }[] = []
  let fail = true
  const fetcher: typeof fetch = async (_input, init) => {
    const header = new Headers(init?.headers).get('Authorization')
    const tier = header === `Bearer ${keys.editAdmission}` ? 'edit' : 'comment'
    sent.push({ tier, body: new Uint8Array(init?.body as ArrayBuffer) })
    if (fail) {
      fail = false
      return new Response(null, { status: 503 })
    }
    return new Response('{"sequence":1}', { status: 200 })
  }
  const coordinator = await TestBootstrapCoordinator.start({
    outbox,
    edit,
    comment,
    editSender,
    commentSender,
    read,
    locks,
    url: 'https://example.test',
    fetch: fetcher,
  })
  await coordinator.enqueue('edit', Uint8Array.of(1))
  await coordinator.enqueue('comment', Uint8Array.of(2))
  await expect(coordinator.flush()).rejects.toThrow()
  expect(sent.map((item) => item.tier)).toEqual(['edit'])
  await coordinator.flush()
  expect(sent.map((item) => item.tier)).toEqual(['edit', 'edit', 'comment'])
  expect(sent[0]!.body).toEqual(sent[1]!.body)
  await coordinator.close()
  outbox.close()
})
it('does not expose either sender when the pair-ready transaction aborts', async () => {
  const { edit, comment, read, outbox, editSender, commentSender, locks } = await setup()
  const put = IDBObjectStore.prototype.put
  let aborted = false
  IDBObjectStore.prototype.put = function (...args) {
    const result = put.apply(this, args)
    const value = args[0] as { bootstrapReady?: boolean }
    if (this.name === 'senders' && value.bootstrapReady && !aborted) {
      aborted = true
      this.transaction.abort()
    }
    return result
  }
  const opts = {
    outbox,
    edit,
    comment,
    editSender,
    commentSender,
    read,
    locks,
    url: 'https://example.test',
    fetch: async () => new Response('{"sequence":1}', { status: 200 }),
  }
  try {
    await expect(TestBootstrapCoordinator.start(opts)).rejects.toThrow()
  } finally {
    IDBObjectStore.prototype.put = put
  }
  expect((await outbox.bootstrapState(edit, fixture.roomId, editSender)).ready).toBe(false)
  expect((await outbox.bootstrapState(comment, fixture.roomId, commentSender)).ready).toBe(false)
  await expect(outbox.enqueue(edit, fixture.roomId, editSender, Uint8Array.of(1))).rejects.toThrow(
    'incomplete',
  )
  const resumed = await TestBootstrapCoordinator.resume({ ...opts, roomId: fixture.roomId })
  expect((await outbox.bootstrapState(edit, fixture.roomId, editSender)).ready).toBe(true)
  expect((await outbox.bootstrapState(comment, fixture.roomId, commentSender)).ready).toBe(true)
  await resumed.close()
  outbox.close()
})
it('reconstructs the missing comment binding after an interrupted first-stage commit', async () => {
  const { edit, comment, read, outbox, name, editSender, commentSender, locks } = await setup()
  await outbox.stageBootstrap(
    edit,
    read.checkpoint,
    { textState: read.textState, commentsState: read.commentsState },
    editSender,
    { editSender, commentSender },
  )
  outbox.close()
  const reopened = await KeptOutbox.open(name)
  const resume = await TestBootstrapCoordinator.resume({
    outbox: reopened,
    edit,
    comment,
    editSender,
    commentSender,
    roomId: fixture.roomId,
    locks,
    url: 'https://example.test',
    fetch: async () => new Response('{"sequence":1}', { status: 200 }),
  })
  expect((await reopened.bootstrapState(edit, fixture.roomId, editSender)).ready).toBe(true)
  expect((await reopened.bootstrapState(comment, fixture.roomId, commentSender)).ready).toBe(true)
  await resume.enqueue('edit', Uint8Array.of(1))
  await resume.close()
  reopened.close()
})
it('binds the edit and comment sender identities as one pair', async () => {
  const { edit, comment, read, outbox, editSender, commentSender, locks } = await setup()
  const first = await TestBootstrapCoordinator.start({
    outbox,
    edit,
    comment,
    editSender,
    commentSender,
    read,
    url: 'https://example.test',
    fetch: async () => new Response('{"sequence":1}', { status: 200 }),
    locks,
  })
  await first.close()
  const other = await outbox.createSender(comment, fixture.roomId)
  await expect(
    TestBootstrapCoordinator.start({
      outbox,
      edit,
      comment,
      editSender,
      commentSender: other,
      read,
      url: 'https://example.test',
      fetch: async () => new Response('{"sequence":1}', { status: 200 }),
      locks,
    }),
  ).rejects.toThrow('context changed')
  await expect(outbox.bootstrapState(comment, fixture.roomId, other)).rejects.toThrow()
  outbox.close()
})
it('ordinary senders cannot automatically transmit bootstrap-bound operations', async () => {
  const { edit, comment, read, outbox, editSender, commentSender, locks } = await setup()
  const { KeptOutboxSender } = await import('../src/kept-outbox-sender.ts')
  let calls = 0
  const fetch: typeof globalThis.fetch = async () => {
    calls++
    return new Response('{"sequence":1}', { status: 200 })
  }
  const coordinator = await TestBootstrapCoordinator.start({
    outbox,
    edit,
    comment,
    editSender,
    commentSender,
    read,
    url: 'https://example.test',
    fetch,
    locks,
  })
  await coordinator.enqueue('comment', Uint8Array.of(1))
  const ordinary = new KeptOutboxSender({
    url: 'https://example.test',
    link: comment,
    context: { roomId: fixture.roomId, epoch: read.checkpoint.context.epoch, generation: 1 },
    sender: commentSender,
    outbox,
    fetch,
  })
  await expect(ordinary.sendNext()).rejects.toThrow('test-only coordinator')
  expect(calls).toBe(0)
  await coordinator.flush()
  expect(calls).toBe(1)
  await coordinator.close()
  outbox.close()
})
it('does not bind either sender when the other has pending operations', async () => {
  const { edit, comment, read, outbox, editSender, commentSender, locks } = await setup()
  const operation = Uint8Array.of(1)
  await outbox.enqueue(comment, fixture.roomId, commentSender, operation)
  const options = {
    outbox,
    edit,
    comment,
    editSender,
    commentSender,
    locks,
    read,
    url: 'https://example.test',
    fetch: async () => new Response('{"sequence":1}'),
  }
  await expect(TestBootstrapCoordinator.start(options)).rejects.toThrow('not empty')
  await expect(outbox.bootstrapState(edit, fixture.roomId, editSender)).rejects.toThrow(
    'unavailable',
  )
  expect(
    (await outbox.recoveryState(comment, fixture.roomId, commentSender)).operations[0]?.message,
  ).toEqual(operation)
  const freshComment = await outbox.createSender(comment, fixture.roomId)
  const coordinator = await TestBootstrapCoordinator.start({
    ...options,
    commentSender: freshComment,
  })
  await coordinator.close()
  outbox.close()
})
it('rolls back both bindings when their transaction aborts', async () => {
  const { edit, comment, read, outbox, editSender, commentSender } = await setup()
  const put = IDBObjectStore.prototype.put
  let writes = 0
  IDBObjectStore.prototype.put = function (...args) {
    const result = put.apply(this, args)
    if (this.name === 'senders' && ++writes === 2) this.transaction.abort()
    return result
  }
  try {
    await expect(
      outbox.stageBootstrapPair(
        edit,
        comment,
        read.checkpoint,
        { textState: read.textState, commentsState: read.commentsState },
        { editSender, commentSender },
      ),
    ).rejects.toThrow()
  } finally {
    IDBObjectStore.prototype.put = put
  }
  await expect(outbox.bootstrapState(edit, fixture.roomId, editSender)).rejects.toThrow(
    'unavailable',
  )
  await expect(outbox.bootstrapState(comment, fixture.roomId, commentSender)).rejects.toThrow(
    'unavailable',
  )
  outbox.close()
})
it('review: concurrent different pairs commit only one binding', async () => {
  const { edit, comment, read, outbox, editSender, commentSender } = await setup()
  const other = await outbox.createSender(comment, fixture.roomId)
  const candidate = { textState: read.textState, commentsState: read.commentsState }
  const results = await Promise.allSettled([
    outbox.stageBootstrapPair(edit, comment, read.checkpoint, candidate, {
      editSender,
      commentSender,
    }),
    outbox.stageBootstrapPair(edit, comment, read.checkpoint, candidate, {
      editSender,
      commentSender: other,
    }),
  ])
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
  const binding = await outbox.bootstrapState(edit, fixture.roomId, editSender)
  const winning = binding.checkpoint.pair.commentSender
  expect([commentSender, other]).toContain(winning)
  expect(
    (await outbox.bootstrapState(comment, fixture.roomId, winning)).checkpoint.pair.editSender,
  ).toBe(editSender)
  const losing = winning === other ? commentSender : other
  await expect(outbox.bootstrapState(comment, fixture.roomId, losing)).rejects.toThrow(
    'unavailable',
  )
  outbox.close()
})
