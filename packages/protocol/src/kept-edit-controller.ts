import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as sync from 'y-protocols/sync'
import type { KeptLinkSecrets } from './kept-access.ts'
import { KeptOutbox } from './kept-outbox.ts'
import { KeptOutboxSender } from './kept-outbox-sender.ts'
import type { KeptRecordContext } from './kept-record.ts'
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
}

// Relay acceptance is not a host save or proof of a complete relay tail.
export class KeptEditController {
  readonly doc: Y.Doc
  private readonly sender: KeptOutboxSender
  private readonly queued: Uint8Array[] = []
  private running = false
  private stopped = false
  private readonly abort = new AbortController()
  private constructor(private readonly options: KeptEditOptions, doc: Y.Doc) {
    this.doc = doc
    this.sender = new KeptOutboxSender(options)
    doc.on('update', this.onUpdate)
  }
  static async open(options: KeptEditOptions): Promise<KeptEditController> {
    if (options.link.access !== 'edit') throw new Error('edit access required')
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, options.baseline)
      const rows = await options.outbox.operations(options.link, options.context.roomId, options.sender)
      for (const row of rows) {
        const msg = decodeMessage(row.message)
        if (msg.type !== MessageType.Sync) throw new Error('unsupported outbox operation')
        const d = decoding.createDecoder(msg.payload)
        if (decoding.readVarUint(d) !== 2) throw new Error('unsupported outbox sync')
        const update = decoding.readVarUint8Array(d)
        if (d.pos !== msg.payload.length) throw new Error('invalid outbox sync')
        Y.applyUpdate(doc, update)
      }
      if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('missing Yjs dependencies')
      const controller = new KeptEditController(options, doc)
      options.onStatus(rows.some(row => !row.acknowledged) ? 'pending' : 'idle')
      if (rows.some(row => !row.acknowledged)) void controller.retry()
      return controller
    } catch (error) { doc.destroy(); throw error }
  }
  private readonly onUpdate = (update: Uint8Array): void => {
    if (this.stopped) return
    const encoder = encoding.createEncoder()
    sync.writeUpdate(encoder, update)
    this.queued.push(encodeMessage(MessageType.Sync, encoding.toUint8Array(encoder)))
    this.options.onStatus('pending')
    void this.retry()
  }
  async retry(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    let sentAny = false
    let failed = false
    this.options.onStatus('pending')
    try {
      while (!this.stopped) {
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
          break
        }
        sentAny = true
      }
    } catch {
      failed = true
      if (!this.stopped) this.options.onStatus('failed')
    } finally {
      this.running = false
      if (!failed && !this.stopped && this.queued.length) void this.retry()
    }
  }
  close(): void {
    this.stopped = true
    this.abort.abort()
    this.doc.off('update', this.onUpdate)
  }
}
