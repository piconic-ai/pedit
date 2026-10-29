import 'fake-indexeddb/auto'
import { evictDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, it } from 'vitest'
import { signingPair } from '../../protocol/src/access-crypto.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../protocol/src/kept-access.ts'
import { KeptEditController } from '../../protocol/src/kept-edit-controller.ts'
import { KeptOutbox } from '../../protocol/src/kept-outbox.ts'
import { createKeptSenderCertificate, sealKeptRecord } from '../../protocol/src/kept-record.ts'
import { KeptRoomClient } from '../../protocol/src/kept-room-client.ts'
import {
  TestBootstrapCoordinator,
  testLockManager,
} from '../../protocol/test/kept-bootstrap-coordinator.ts'
import fixture from '../../testdata/kept-read-interop.json'
import shared from '../../testdata/kept-recovery-wire.json'
import { KeptCommentController } from '../../web/src/kept-comment-controller.ts'

const bytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
it('stages a signed Room read and drains text before comment after a retry', async () => {
  const edit = parseKeptFragment(fixture.fragment)!
  const keys = await deriveKeptRoomKeys(edit, fixture.roomId)
  const comment = parseKeptFragment(keys.fragments.comment ?? '')
  if (!comment || comment.access !== 'comment') throw Error('fixture')
  const epoch = Uint8Array.from(fixture.epoch.match(/../g)!, (v) => parseInt(v, 16))
  const room = env.ROOM.get(env.ROOM.idFromName(fixture.roomId)),
    base = `https://room/internal/kept/${fixture.roomId}`
  const init = await room.fetch(`${base}/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Host ${fixture.hostToken}`,
      'X-Pedit-Editor': fixture.editor,
      'X-Pedit-Commenter': fixture.commenter,
      'X-Pedit-Reader': fixture.reader,
      'X-Pedit-Epoch': fixture.epoch,
      'X-Pedit-Keep-Seconds': '60',
    },
    body: bytes(fixture.checkpoint),
  })
  expect(init.status).toBe(204)
  const source = await signingPair(new Uint8Array(32).fill(11)),
    cert = await createKeptSenderCertificate(keys, source.publicKey)
  const remote = await sealKeptRecord(
    keys,
    { roomId: fixture.roomId, epoch, generation: 1 },
    source.sign,
    cert,
    1,
    bytes(shared.textMessage),
  )
  const appended = await room.fetch(`${base}/append`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${fixture.editor}`, 'X-Pedit-Epoch': fixture.epoch },
    body: Uint8Array.from(remote).buffer,
  })
  expect(appended.status).toBe(200)
  await appended.text()
  const fetcher: typeof fetch = (input, init) => room.fetch(new Request(input, init))
  const reader = new KeptRoomClient({
    url: 'https://room',
    keys,
    fetch: fetcher,
    attachmentInventory: async () => 'none',
  })
  const read = await reader.inspect()
  const outbox = await KeptOutbox.open(`room-bootstrap-${crypto.randomUUID()}`)
  try {
    const editSender = await outbox.createSender(edit, fixture.roomId),
      commentSender = await outbox.createSender(comment, fixture.roomId)
    const seen: string[] = []
    let fail = true
    const transport: typeof fetch = async (input, init) => {
      const tier =
        new Headers(init?.headers).get('Authorization') === `Bearer ${keys.editAdmission}`
          ? 'edit'
          : 'comment'
      seen.push(tier)
      if (fail) {
        fail = false
        return new Response(null, { status: 503 })
      }
      return room.fetch(new Request(input, init))
    }
    const locks = testLockManager()
    const coordinator = await TestBootstrapCoordinator.start({
      outbox,
      locks,
      edit,
      comment,
      editSender,
      commentSender,
      read,
      url: 'https://room',
      fetch: transport,
    })
    await coordinator.enqueue('edit', bytes(shared.textMessage))
    await coordinator.enqueue('comment', bytes(shared.commentsMessage))
    await expect(coordinator.flush()).rejects.toThrow()
    expect(seen).toEqual(['edit'])
    await coordinator.flush()
    expect(seen).toEqual(['edit', 'edit', 'comment'])
    const inspected = await reader.inspect()
    expect(inspected.records).toBe(3)
    expect(inspected.status).toBe('tail-unverified')
    expect(inspected.applicable).toBe(false)
    await coordinator.close()
    const editor = await KeptEditController.open({
      url: 'https://room',
      link: edit,
      context: { roomId: fixture.roomId, epoch, generation: 1 },
      sender: editSender,
      outbox,
      baseline: read.checkpoint.textState,
      onStatus: () => {},
      locks,
      fetch: fetcher,
    })
    const comments = await KeptCommentController.open({
      url: 'https://room',
      link: comment,
      context: { roomId: fixture.roomId, epoch, generation: 1 },
      sender: commentSender,
      outbox,
      metaId: read.checkpoint.metadataId,
      text: read.checkpoint.textState,
      comments: read.checkpoint.commentsState,
      name: () => 'test',
      onStatus: () => {},
      locks,
      fetch: fetcher,
    })
    expect(editor.text()).toContain('A')
    expect(comments.commentState().length).toBeGreaterThan(0)
    await editor.close()
    await comments.close()
  } finally {
    outbox.close()
    await evictDurableObject(room, { webSockets: 'close' })
  }
}, 30000)
