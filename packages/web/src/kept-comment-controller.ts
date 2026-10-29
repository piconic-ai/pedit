import {
  checkMetaUpdate,
  decodeFiles,
  decodeMessage,
  encodeFileDoc,
  encodeMessage,
  MAX_FILE_ID,
  MessageType,
} from '@pedit/protocol'
import type { KeptLinkSecrets } from '@pedit/protocol/kept-access'
import { checkKeptCommentsState } from '@pedit/protocol/kept-comments-schema'
import { KeptOutbox } from '@pedit/protocol/kept-outbox'
import { KeptOutboxSender } from '@pedit/protocol/kept-outbox-sender'
import type { KeptRecordContext } from '@pedit/protocol/kept-record'
import { checkKeptTextState } from '@pedit/protocol/kept-text-schema'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import * as Y from 'yjs'
import { CommentsView } from './comments.ts'

type CommentLink = Extract<KeptLinkSecrets, { access: 'comment' }>
export type KeptCommentStatus = 'idle' | 'pending' | 'relay-accepted' | 'failed'
export type KeptCommentOptions = {
  url: string
  link: CommentLink
  context: KeptRecordContext
  metaId: number
  text: Uint8Array
  comments: Uint8Array
  sender: string
  outbox: KeptOutbox
  name: () => string
  onStatus: (status: KeptCommentStatus) => void
  fetch?: typeof fetch
  locks?: LockManager
}
type RemoteKind = 'text' | 'comments'
const tag = (kind: RemoteKind) => (kind === 'text' ? 1 : 2)

async function lockWriter(
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
function stateValid(doc: Y.Doc, kind: RemoteKind): boolean {
  if (doc.store.pendingStructs || doc.store.pendingDs) return false
  const state = Y.encodeStateAsUpdate(doc)
  if (kind === 'text') return checkKeptTextState(state)
  if (!checkKeptCommentsState(state)) return false
  const empty = new Y.Doc()
  try {
    return checkMetaUpdate(empty, state) === null
  } finally {
    empty.destroy()
  }
}
function readUpdate(doc: Y.Doc, update: Uint8Array): void {
  const decoder = decoding.createDecoder(update)
  Y.readUpdate(decoder, doc)
  if (decoder.pos !== update.length) throw new Error('invalid Yjs update')
}
function decodeOperation(message: Uint8Array, metaId: number): Uint8Array {
  const outer = decodeMessage(message)
  if (outer.type !== MessageType.Files) throw new Error('unsupported comment operation')
  const file = decodeFiles(outer.payload)
  if (file.kind !== 'doc' || file.file !== metaId || file.type !== MessageType.Sync)
    throw new Error('wrong metadata')
  const d = decoding.createDecoder(file.payload)
  if (decoding.readVarUint(d) !== 2) throw new Error('invalid comment sync')
  const update = decoding.readVarUint8Array(d)
  if (!update.length || d.pos !== file.payload.length) throw new Error('invalid comment sync')
  return update
}

// The caller supplies an authenticated context and manifest binding. The tail
// may still be incomplete; relay acceptance does not mean a host save.
export class KeptCommentController {
  private readonly text = new Y.Doc()
  private readonly comments = new Y.Doc()
  private readonly sender: KeptOutboxSender
  private active: Promise<unknown> | undefined
  private sending: Promise<void> | undefined
  private sendRevision = 0
  private closeAttempt: Promise<void> | undefined
  private failed = false
  private closing = false
  private closed = false
  private readonly abort = new AbortController()
  private constructor(
    private readonly options: KeptCommentOptions,
    private readonly release: () => Promise<void>,
  ) {
    this.sender = new KeptOutboxSender(options)
  }
  static async open(input: KeptCommentOptions): Promise<KeptCommentController> {
    if (
      input.link.access !== 'comment' ||
      !Number.isSafeInteger(input.metaId) ||
      input.metaId < 1 ||
      input.metaId > MAX_FILE_ID
    )
      throw new Error('invalid comment access')
    const options = {
      ...input,
      link: structuredClone(input.link),
      context: { ...input.context, epoch: Uint8Array.from(input.context.epoch) },
      text: Uint8Array.from(input.text),
      comments: Uint8Array.from(input.comments),
    }
    const release = await lockWriter(
      options.locks ?? globalThis.navigator?.locks,
      options.context.roomId,
      options.sender,
    )
    let controller: KeptCommentController | undefined
    try {
      controller = new KeptCommentController(options, release)
      readUpdate(controller.text, options.text)
      readUpdate(controller.comments, options.comments)
      const snapshot = await options.outbox.recoveryState(
        options.link,
        options.context.roomId,
        options.sender,
      )
      for (const remote of snapshot.remote) {
        if (remote[0] === tag('text')) readUpdate(controller.text, remote.subarray(1))
        else if (remote[0] === tag('comments')) readUpdate(controller.comments, remote.subarray(1))
        else throw new Error('invalid remote dependency')
      }
      for (const operation of snapshot.operations)
        readUpdate(controller.comments, decodeOperation(operation.message, options.metaId))
      if (!stateValid(controller.text, 'text') || !stateValid(controller.comments, 'comments'))
        throw new Error('invalid recovery state')
      options.onStatus(snapshot.operations.some((row) => !row.acknowledged) ? 'pending' : 'idle')
      if (snapshot.operations.some((row) => !row.acknowledged)) void controller.retry()
      return controller
    } catch (error) {
      controller?.text.destroy()
      controller?.comments.destroy()
      await release()
      throw error
    }
  }
  textState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.text)
  }
  commentState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.comments)
  }
  start(from: number, to: number, body: string): Promise<string> {
    return this.mutate((view) => {
      const text = this.text.getText('content').toString()
      const splitPair = (index: number) =>
        index > 0 &&
        index < text.length &&
        /[\uD800-\uDBFF]/.test(text.charAt(index - 1)) &&
        /[\uDC00-\uDFFF]/.test(text.charAt(index))
      if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        from < 0 ||
        to <= from ||
        to > text.length ||
        splitPair(from) ||
        splitPair(to)
      )
        throw new Error('invalid comment range')
      const id = view.start(from, to, body)
      if (!id) throw new Error('comment refused')
      return id
    })
  }
  reply(thread: string, body: string): Promise<void> {
    return this.mutate((view) => {
      if (!view.reply(thread, body)) throw new Error('reply refused')
    })
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.closed || this.active)
      return Promise.reject(new Error('comment editor unavailable'))
    const task = operation()
    this.active = task
    void task.then(
      () => {
        if (this.active === task) this.active = undefined
      },
      () => {
        if (this.active === task) this.active = undefined
      },
    )
    return task
  }
  private mutate<T>(operation: (view: CommentsView) => T): Promise<T> {
    return this.run(async () => {
      const draft = new Y.Doc()
      readUpdate(draft, Y.encodeStateAsUpdate(this.comments))
      const view = new CommentsView(draft, this.text, { name: this.options.name })
      try {
        const result = operation(view)
        const update = Y.encodeStateAsUpdate(draft, Y.encodeStateVector(this.comments))
        if (checkMetaUpdate(this.comments, update) || !stateValid(draft, 'comments'))
          throw new Error('invalid comment update')
        const e = encoding.createEncoder()
        sync.writeUpdate(e, update)
        const message = encodeMessage(
          MessageType.Files,
          encodeFileDoc(this.options.metaId, MessageType.Sync, encoding.toUint8Array(e)),
        )
        this.sendRevision++
        this.options.onStatus('pending')
        await this.sender.enqueue(message)
        Y.applyUpdate(this.comments, update)
        this.failed = false
        void this.retry()
        return result
      } catch (error) {
        this.failed = true
        this.options.onStatus('failed')
        throw error
      } finally {
        view.destroy()
        draft.destroy()
      }
    })
  }
  applyRemote(kind: RemoteKind, input: Uint8Array): Promise<void> {
    return this.run(async () => {
      if (kind !== 'text' && kind !== 'comments') throw new Error('invalid remote kind')
      const update = Uint8Array.from(input)
      const target = kind === 'text' ? this.text : this.comments
      const probe = new Y.Doc()
      try {
        readUpdate(probe, Y.encodeStateAsUpdate(target))
        if (kind === 'comments' && checkMetaUpdate(probe, update))
          throw new Error('invalid remote comment')
        readUpdate(probe, update)
        if (!stateValid(probe, kind)) throw new Error('invalid remote state')
        const remote = new Uint8Array(update.length + 1)
        remote[0] = tag(kind)
        remote.set(update, 1)
        await this.options.outbox.saveRemote(
          this.options.link,
          this.options.context.roomId,
          this.options.sender,
          remote,
        )
        Y.applyUpdate(target, update)
      } finally {
        probe.destroy()
      }
    })
  }
  retry(): Promise<void> {
    if (this.closing || this.closed) return Promise.resolve()
    this.sendRevision++
    if (this.sending) return this.sending
    const task = (async () => {
      let sent = false
      try {
        for (;;) {
          const observed = this.sendRevision
          const result = await this.sender.sendNext(this.abort.signal)
          if (result.status !== 'idle') {
            sent = true
            continue
          }
          await this.waitActive()
          if (observed !== this.sendRevision) continue
          this.options.onStatus(this.failed ? 'failed' : sent ? 'relay-accepted' : 'idle')
          return
        }
      } catch {
        if (!this.closing) this.options.onStatus('failed')
      }
    })()
    this.sending = task
    void task.then(() => {
      if (this.sending === task) this.sending = undefined
    })
    return task
  }
  private async waitActive(): Promise<void> {
    if (!this.active) return
    try {
      await this.active
    } catch {}
  }
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.closeAttempt) return this.closeAttempt
    const attempt = this.drain()
    this.closeAttempt = attempt
    void attempt.then(
      () => {
        this.closeAttempt = undefined
      },
      () => {
        this.closeAttempt = undefined
      },
    )
    return attempt
  }
  private async drain(): Promise<void> {
    this.closing = true
    this.abort.abort()
    await this.waitActive()
    if (this.sending) await this.sending
    this.text.destroy()
    this.comments.destroy()
    await this.release()
    this.closed = true
  }
}
