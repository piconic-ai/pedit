import type { KeptLinkSecrets } from '../src/kept-access.ts'
import { KeptOutbox } from '../src/kept-outbox.ts'
import { KeptOutboxSender } from '../src/kept-outbox-sender.ts'
import type { KeptAuthenticatedCheckpoint, KeptReadInspection } from '../src/kept-room-client.ts'

async function acquire(
  locks: LockManager | undefined,
  room: string,
  sender: string,
): Promise<() => Promise<void>> {
  if (!locks) throw new Error('exclusive writer unavailable')
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let accept!: () => void, refuse!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    accept = resolve
    refuse = reject
  })
  const request = locks.request(
    `pedit-v6-writer:${room}:${sender}`,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) {
        refuse(new Error('kept writer already open'))
        return
      }
      accept()
      await held
    },
  )
  void request.catch(() => refuse(new Error('exclusive writer unavailable')))
  await ready
  return async () => {
    release()
    await request
  }
}

// Test-only coordinator. It keeps both senders closed to new input while the
// editor's operations are drained, then drains comment operations.
export class TestBootstrapCoordinator {
  private busy = false
  private closed = false
  private constructor(
    private readonly outbox: KeptOutbox,
    private readonly edit: KeptLinkSecrets,
    private readonly comment: KeptLinkSecrets,
    private readonly room: string,
    private readonly editSender: string,
    private readonly commentSender: string,
    private readonly context: { roomId: string; epoch: Uint8Array; generation: number },
    private readonly fetcher: typeof fetch,
    private readonly release: () => Promise<void>,
  ) {}
  static async start(options: {
    outbox: KeptOutbox
    edit: KeptLinkSecrets
    comment: KeptLinkSecrets
    editSender: string
    commentSender: string
    read: KeptReadInspection
    url: string
    fetch: typeof fetch
    locks?: LockManager
  }): Promise<TestBootstrapCoordinator> {
    const { outbox, edit, comment, editSender, commentSender, read } = options
    if (
      edit.access !== 'edit' ||
      comment.access !== 'comment' ||
      read.applicable !== false ||
      read.status !== 'tail-unverified'
    )
      throw new Error('invalid bootstrap')
    const checkpoint: KeptAuthenticatedCheckpoint = read.checkpoint
    const release = await this.acquirePair(
      options.locks,
      checkpoint.context.roomId,
      editSender,
      commentSender,
    )
    try {
      const candidate = { textState: read.textState, commentsState: read.commentsState }
      await outbox.stageBootstrap(edit, checkpoint, candidate, editSender, {
        editSender,
        commentSender,
      })
      await outbox.stageBootstrap(comment, checkpoint, candidate, commentSender, {
        editSender,
        commentSender,
      })
      await this.resumeSender(outbox, edit, checkpoint.context.roomId, editSender)
      await this.resumeSender(outbox, comment, checkpoint.context.roomId, commentSender)
      await outbox.finishBootstrapPair(
        edit,
        comment,
        checkpoint.context.roomId,
        editSender,
        commentSender,
      )
      const context = {
        roomId: checkpoint.context.roomId,
        epoch: Uint8Array.from(checkpoint.context.epoch),
        generation: checkpoint.context.generation,
      }
      return new TestBootstrapCoordinator(
        outbox,
        edit,
        comment,
        options.url,
        editSender,
        commentSender,
        context,
        options.fetch,
        release,
      )
    } catch (error) {
      await release()
      throw error
    }
  }
  private static async acquirePair(
    input: LockManager | undefined,
    room: string,
    editSender: string,
    commentSender: string,
  ): Promise<() => Promise<void>> {
    const locks = input ?? globalThis.navigator?.locks
    const first = await acquire(locks, room, editSender)
    try {
      const second = await acquire(locks, room, commentSender)
      return async () => {
        await second()
        await first()
      }
    } catch (error) {
      await first()
      throw error
    }
  }
  static async resume(options: {
    outbox: KeptOutbox
    edit: KeptLinkSecrets
    comment: KeptLinkSecrets
    editSender: string
    commentSender: string
    roomId: string
    url: string
    fetch: typeof fetch
    locks?: LockManager
  }): Promise<TestBootstrapCoordinator> {
    const { outbox, edit, comment, editSender, commentSender, roomId } = options
    if (edit.access !== 'edit' || comment.access !== 'comment') throw new Error('invalid bootstrap')
    const release = await this.acquirePair(options.locks, roomId, editSender, commentSender)
    try {
      const stored = (await outbox.bootstrapState(edit, roomId, editSender)).checkpoint
      const epoch = Uint8Array.from(stored.context.epoch.match(/../g)!, (value) =>
        parseInt(value, 16),
      )
      const checkpoint: KeptAuthenticatedCheckpoint = {
        kind: 'authenticated-checkpoint',
        context: { ...stored.context, epoch },
        metadataId: stored.metadataId,
        ciphertext: stored.ciphertext,
        textState: stored.baselineText,
        commentsState: stored.baselineComments,
      }
      await outbox.stageBootstrap(
        comment,
        checkpoint,
        { textState: stored.candidateText, commentsState: stored.candidateComments },
        commentSender,
        { editSender, commentSender },
      )
      await this.resumeSender(outbox, edit, roomId, editSender)
      await this.resumeSender(outbox, comment, roomId, commentSender)
      await outbox.finishBootstrapPair(edit, comment, roomId, editSender, commentSender)
      return new TestBootstrapCoordinator(
        outbox,
        edit,
        comment,
        options.url,
        editSender,
        commentSender,
        { roomId, epoch, generation: stored.context.generation },
        options.fetch,
        release,
      )
    } catch (error) {
      await release()
      throw error
    }
  }
  static async resumeSender(
    outbox: KeptOutbox,
    link: KeptLinkSecrets,
    room: string,
    sender: string,
  ): Promise<void> {
    const state = await outbox.bootstrapState(link, room, sender)
    if (state.ready) return
    const prefix = (tag: number, bytes: Uint8Array) => {
      const out = new Uint8Array(bytes.length + 1)
      out[0] = tag
      out.set(bytes, 1)
      return out
    }
    if (link.access === 'edit')
      await outbox.saveRemote(link, room, sender, state.checkpoint.candidateText)
    else if (link.access === 'comment') {
      await outbox.saveRemote(link, room, sender, prefix(1, state.checkpoint.candidateText))
      await outbox.saveRemote(link, room, sender, prefix(2, state.checkpoint.candidateComments))
    } else throw new Error('invalid bootstrap access')
  }
  async close(): Promise<void> {
    if (this.closed) return
    if (this.busy) throw new Error('bootstrap busy')
    this.closed = true
    await this.release()
  }
  async enqueue(kind: 'edit' | 'comment', message: Uint8Array): Promise<number> {
    if (this.busy || this.closed) throw new Error('bootstrap unavailable')
    this.busy = true
    try {
      return await this.outbox.enqueue(
        kind === 'edit' ? this.edit : this.comment,
        this.context.roomId,
        kind === 'edit' ? this.editSender : this.commentSender,
        message,
      )
    } finally {
      this.busy = false
    }
  }
  async flush(): Promise<void> {
    if (this.busy || this.closed) throw new Error('bootstrap unavailable')
    this.busy = true
    try {
      for (const [link, sender] of [
        [this.edit, this.editSender],
        [this.comment, this.commentSender],
      ] as const) {
        const writer = new KeptOutboxSender({
          url: this.room,
          link,
          context: this.context,
          sender,
          outbox: this.outbox,
          fetch: this.fetcher,
          testOnlyBootstrap: true,
        })
        while ((await writer.sendNext()).status !== 'idle') {}
      }
    } finally {
      this.busy = false
    }
  }
}

export function testLockManager(): LockManager {
  const active = new Set<string>()
  return {
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
}
