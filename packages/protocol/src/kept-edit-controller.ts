import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import * as Y from 'yjs'
import type { KeptLinkSecrets } from './kept-access.ts'
import { KeptOutbox } from './kept-outbox.ts'
import { KeptOutboxSender } from './kept-outbox-sender.ts'
import type { KeptRecordContext } from './kept-record.ts'
import { checkKeptTextState } from './kept-text-schema.ts'
import { decodeMessage, encodeMessage, MessageType } from './message.ts'

export type KeptEditStatus = 'idle' | 'pending' | 'relay-accepted' | 'failed'
export type KeptEditOptions = {
  url: string
  link: KeptLinkSecrets
  context: KeptRecordContext
  sender: string
  outbox: KeptOutbox
  baseline: Uint8Array
  onStatus: (status: KeptEditStatus) => void
  fetch?: typeof fetch
  locks?: LockManager
}

async function acquireWriter(
  locks: LockManager | undefined,
  room: string,
  sender: string,
): Promise<() => Promise<void>> {
  if (!locks) throw new Error('exclusive writer unavailable')
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let acquired!: () => void, refused!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve
    refused = reject
  })
  const request = locks.request(
    `pedit-v6-writer:${room}:${sender}`,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) {
        refused(new Error('kept writer already open'))
        return
      }
      acquired()
      await held
    },
  )
  void request.catch(() => refused(new Error('exclusive writer unavailable')))
  await ready
  return async () => {
    release()
    await request
  }
}

// Relay acceptance is not a host save or proof of a complete relay tail.
export class KeptEditController {
  readonly #doc: Y.Doc
  private readonly sender: KeptOutboxSender
  private readonly queued: Uint8Array[] = []
  private running: Promise<void> | undefined
  private remoteWork: Promise<void> | undefined
  private closeAttempt: Promise<void> | undefined
  private closing = false
  private stopped = false
  private invalid = false
  private readonly abort = new AbortController()
  private constructor(
    private readonly options: KeptEditOptions,
    doc: Y.Doc,
    private readonly releaseWriter: () => Promise<void>,
  ) {
    this.#doc = doc
    this.sender = new KeptOutboxSender(options)
    doc.on('update', this.onUpdate)
  }
  static async open(options: KeptEditOptions): Promise<KeptEditController> {
    if (options.link.access !== 'edit') throw new Error('edit access required')
    const release = await acquireWriter(
      options.locks ?? globalThis.navigator?.locks,
      options.context.roomId,
      options.sender,
    )
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, options.baseline)
      const snapshot = await options.outbox.recoveryState(
        options.link,
        options.context.roomId,
        options.sender,
      )
      for (const update of snapshot.remote) Y.applyUpdate(doc, update)
      const rows = snapshot.operations
      for (const row of rows) {
        const msg = decodeMessage(row.message)
        if (msg.type !== MessageType.Sync) throw new Error('unsupported outbox operation')
        const d = decoding.createDecoder(msg.payload)
        if (decoding.readVarUint(d) !== 2) throw new Error('unsupported outbox sync')
        const update = decoding.readVarUint8Array(d)
        if (d.pos !== msg.payload.length) throw new Error('invalid outbox sync')
        Y.applyUpdate(doc, update)
      }
      if (
        doc.store.pendingStructs ||
        doc.store.pendingDs ||
        !checkKeptTextState(Y.encodeStateAsUpdate(doc))
      )
        throw new Error('invalid or incomplete kept text')
      const controller = new KeptEditController(options, doc, release)
      options.onStatus(rows.some((row) => !row.acknowledged) ? 'pending' : 'idle')
      if (rows.some((row) => !row.acknowledged)) void controller.retry()
      return controller
    } catch (error) {
      doc.destroy()
      await release()
      throw error
    }
  }
  text(): string {
    return this.#doc.getText('content').toString()
  }
  // Apply one editor replacement as bounded Yjs transactions, preserving UTF-16
  // pairs and the user's replacement order. No update bytes are split.
  async replace(from: number, to: number, value: string): Promise<void> {
    if (this.remoteWork) throw new Error('remote update in progress')
    const text = this.#doc.getText('content')
    if (
      this.stopped ||
      this.closing ||
      this.invalid ||
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 0 ||
      to < from ||
      to > text.length
    )
      throw new Error('invalid kept edit')
    const probe = new Y.Doc()
    try {
      Y.applyUpdate(probe, Y.encodeStateAsUpdate(this.#doc))
      probe.clientID = this.#doc.clientID
      this.replaceText(probe.getText('content'), from, to, value)
      if (!checkKeptTextState(Y.encodeStateAsUpdate(probe)))
        throw new Error('kept text capacity exceeded')
    } finally {
      probe.destroy()
    }
    this.replaceText(text, from, to, value)
  }
  private replaceText(text: Y.Text, from: number, to: number, value: string): void {
    if (to > from) text.delete(from, to - from)
    let offset = 0
    while (offset < value.length) {
      let end = Math.min(offset + 8192, value.length)
      if (
        end < value.length &&
        /[\uD800-\uDBFF]/.test(value.charAt(end - 1)) &&
        /[\uDC00-\uDFFF]/.test(value.charAt(end))
      )
        end--
      text.insert(from + offset, value.slice(offset, end))
      offset = end
    }
  }
  applyRemote(update: Uint8Array): Promise<void> {
    if (this.stopped || this.closing || this.invalid)
      return Promise.reject(new Error('kept editor closed'))
    const input = Uint8Array.from(update)
    const apply = async () => {
      const probe = new Y.Doc()
      try {
        Y.applyUpdate(probe, Y.encodeStateAsUpdate(this.#doc))
        const decoder = decoding.createDecoder(input)
        Y.readUpdate(decoder, probe)
        if (
          decoder.pos !== input.length ||
          probe.store.pendingStructs ||
          probe.store.pendingDs ||
          !checkKeptTextState(Y.encodeStateAsUpdate(probe))
        )
          throw new Error('invalid remote text state')
        await this.options.outbox.saveRemote(
          this.options.link,
          this.options.context.roomId,
          this.options.sender,
          input,
        )
        Y.applyUpdate(this.#doc, input, this)
      } finally {
        probe.destroy()
      }
    }
    const work = this.remoteWork ? this.remoteWork.then(apply, apply) : apply()
    this.remoteWork = work
    void work.then(
      () => {
        if (this.remoteWork === work) this.remoteWork = undefined
      },
      () => {
        if (this.remoteWork === work) this.remoteWork = undefined
      },
    )
    return work
  }
  private readonly onUpdate = (
    update: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ): void => {
    if (this.stopped || !transaction.local) return
    if (this.invalid || !checkKeptTextState(Y.encodeStateAsUpdate(this.#doc))) {
      this.invalid = true
      this.options.onStatus('failed')
      return
    }
    const encoder = encoding.createEncoder()
    sync.writeUpdate(encoder, update)
    this.queued.push(encodeMessage(MessageType.Sync, encoding.toUint8Array(encoder)))
    this.options.onStatus('pending')
    if (!this.closing) void this.retry()
  }
  retry(): Promise<void> {
    if (this.running) return this.running
    if (this.stopped || this.closing || this.invalid) return Promise.resolve()
    this.options.onStatus('pending')
    const work = this.pump()
    this.running = work
    void work.finally(() => {
      this.running = undefined
    })
    return work
  }
  private async pump(): Promise<void> {
    let sentAny = false
    try {
      while (!this.closing && !this.stopped && !this.invalid) {
        const first = this.queued[0]
        if (first) {
          await this.sender.enqueue(first)
          this.queued.shift()
          continue
        }
        const sent = await this.sender.sendNext(this.abort.signal)
        if (sent.status === 'idle') {
          if (this.queued.length) continue
          this.options.onStatus(sentAny ? 'relay-accepted' : 'idle')
          if (this.queued.length) continue
          break
        }
        sentAny = true
      }
    } catch {
      if (!this.closing && !this.stopped) this.options.onStatus('failed')
    }
  }
  // The caller stops its editor before closing. On error the listener and
  // unsaved queue remain available for another close attempt.
  close(): Promise<void> {
    if (this.stopped) return Promise.resolve()
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
    if (this.running) await this.running
    if (this.remoteWork) await this.remoteWork
    if (this.invalid) throw new Error('invalid kept text state')
    try {
      while (this.queued.length) {
        const first = this.queued[0]
        if (!first) break
        await this.sender.enqueue(first)
        this.queued.shift()
      }
    } catch (error) {
      this.options.onStatus('failed')
      throw error
    }
    this.stopped = true
    this.#doc.off('update', this.onUpdate)
    await this.releaseWriter()
  }
}
