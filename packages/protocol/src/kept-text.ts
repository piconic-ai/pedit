import * as Y from 'yjs'
import type { RoomKeys } from './access.ts'
import { decrypt, encrypt } from './cipher.ts'
import { MAX_FRAME_BYTES } from './frame.ts'

const DOMAIN = new TextEncoder().encode('pedit kept text v1\0')
const LIMIT = 8 * 1024 * 1024
export class KeptTextClosedError extends Error {
  constructor() {
    super('kept room expired')
  }
}

export type KeptTextStatus = 'pending' | 'kept' | 'failed'
export type KeptTextOptions = {
  origin: string
  roomId: string
  keys: RoomKeys
  doc: Y.Doc
  fetch?: typeof fetch
  onStatus?: (status: KeptTextStatus) => void
}

export class KeptTextClient {
  readonly state = { hostAway: false, keepUntil: 0, logEntries: 0 }
  private readonly url: string
  private readonly abort = new AbortController()
  private readonly sender = crypto.randomUUID()
  private work: Promise<void> = Promise.resolve()
  private readonly pending: { update: Uint8Array; body?: Uint8Array }[] = []
  private denied = false
  private readonly options: KeptTextOptions
  constructor(options: KeptTextOptions) {
    this.options = options
    let url: URL
    try {
      url = new URL(options.origin)
    } catch {
      throw new Error('invalid kept room')
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== options.origin ||
      !/^[A-Za-z0-9_-]{22}$/.test(options.roomId)
    )
      throw new Error('invalid kept room')
    this.url = `${url.origin}/api/rooms/${options.roomId}/keep`
    options.doc.on('update', this.record)
  }
  private readonly record = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return
    if (this.options.keys.access !== 'edit') {
      this.denied = true
      return
    }
    this.pending.push({ update: Uint8Array.from(update) })
    this.options.onStatus?.('pending')
  }
  refresh(): Promise<void> {
    return this.run(async () => {
      const response = await this.request('GET')
      const value: unknown = JSON.parse(await boundedText(response))
      if (!isSnapshot(value)) throw new Error('invalid kept response')
      const updates = [await this.open(value.snapshot)]
      let previous = 0
      for (const entry of value.entries) {
        if (entry.id <= previous || entry.id > value.tail) throw new Error('invalid kept entry')
        updates.push(await this.open(entry.body))
        previous = entry.id
      }
      const probe = new Y.Doc()
      try {
        probe.getText('content')
        Y.applyUpdate(probe, Y.encodeStateAsUpdate(this.options.doc))
        for (const update of updates) Y.applyUpdate(probe, update)
        if (probe.share.size > 1 || probe.store.pendingStructs || probe.store.pendingDs)
          throw new Error('invalid kept text')
        this.abort.signal.throwIfAborted()
        this.options.doc.transact(() => {
          for (const update of updates) Y.applyUpdate(this.options.doc, update, this)
        }, this)
      } finally {
        probe.destroy()
      }
      Object.assign(this.state, {
        hostAway: value.hostAway,
        keepUntil: value.keepUntil,
        logEntries: value.entries.length,
      })
    })
  }
  flush(): Promise<void> {
    return this.run(async () => {
      if (this.denied) throw new Error('edit link required')
      while (this.pending.length) {
        const entry = this.pending[0]
        const signer = this.options.keys.signer
        if (!entry || signer?.access !== 'edit') throw new Error('edit link required')
        if (entry.update.length > MAX_FRAME_BYTES - DOMAIN.length - 64 - 28)
          throw new Error('kept edit too large')
        if (!entry.body) {
          const message = join(DOMAIN, entry.update)
          const signature = new Uint8Array(
            await crypto.subtle.sign('Ed25519', signer.key, Uint8Array.from(message)),
          )
          entry.body = await encrypt(this.options.keys.frameKey, join(message, signature))
        }
        if (entry.body.length > MAX_FRAME_BYTES) throw new Error('kept edit too large')
        const response = await this.request('POST', entry.body)
        void response.body?.cancel().catch(() => {})
        this.pending.shift()
      }
      this.options.onStatus?.('kept')
    })
  }
  close(): void {
    this.abort.abort()
    this.options.doc.off('update', this.record)
  }
  private run(work: () => Promise<void>): Promise<void> {
    const next = this.work
      .catch(() => {})
      .then(() => {
        this.abort.signal.throwIfAborted()
        return work()
      })
    this.work = next
    return next.catch((error: unknown) => {
      this.options.onStatus?.('failed')
      if (error instanceof KeptTextClosedError) throw error
      throw new Error('kept text operation failed')
    })
  }

  private async request(method: 'GET' | 'POST', body?: Uint8Array): Promise<Response> {
    const headers = new Headers({
      'X-Pedit-Admission': this.options.keys.editAdmission ?? this.options.keys.readAdmission,
    })
    if (method === 'POST') headers.set('X-Pedit-Sender', this.sender)
    const response = await (this.options.fetch ?? fetch)(
      `${this.url}${method === 'POST' ? '/append' : ''}`,
      {
        method,
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: this.abort.signal,
        body: body ? Uint8Array.from(body) : undefined,
      },
    )
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (response.status === 410) throw new KeptTextClosedError()
      throw new Error('kept request refused')
    }
    return response
  }
  private async open(value: string): Promise<Uint8Array> {
    if (value.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4) throw new Error('kept frame too large')
    const decoded = atob(value)
    if (btoa(decoded) !== value) throw new Error('invalid kept frame')
    const ciphertext = Uint8Array.from(decoded, (char) => char.charCodeAt(0))
    if (ciphertext.length > MAX_FRAME_BYTES) throw new Error('kept frame too large')
    const plain = await decrypt(this.options.keys.frameKey, ciphertext)
    const message = plain.subarray(0, plain.length - 64)
    if (
      message.length <= DOMAIN.length ||
      !DOMAIN.every((byte, i) => message[i] === byte) ||
      !(await crypto.subtle.verify(
        'Ed25519',
        this.options.keys.editKey,
        Uint8Array.from(plain.subarray(plain.length - 64)),
        Uint8Array.from(message),
      ))
    )
      throw new Error('invalid kept signature')
    return message.slice(DOMAIN.length)
  }
}
function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length)
  result.set(a)
  result.set(b, a.length)
  return result
}
type Snapshot = {
  snapshot: string
  entries: { id: number; body: string }[]
  tail: number
  hostAway: boolean
  keepUntil: number
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function isSnapshot(value: unknown): value is Snapshot {
  return (
    object(value) &&
    typeof value.snapshot === 'string' &&
    Array.isArray(value.entries) &&
    value.entries.length <= 1000 &&
    value.entries.every(
      (entry: unknown) =>
        object(entry) &&
        typeof entry.id === 'number' &&
        Number.isSafeInteger(entry.id) &&
        typeof entry.body === 'string',
    ) &&
    typeof value.tail === 'number' &&
    Number.isSafeInteger(value.tail) &&
    value.tail >= 0 &&
    typeof value.hostAway === 'boolean' &&
    typeof value.keepUntil === 'number' &&
    Number.isSafeInteger(value.keepUntil) &&
    value.keepUntil >= 0
  )
}
async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new Error('missing kept response')
  let size = 0,
    chunks = 0
  const limit = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.length
      if (size > LIMIT || ++chunks > 8192) throw new Error('kept response too large')
      controller.enqueue(chunk)
    },
  })
  const bytes = await new Response(response.body.pipeThrough(limit)).arrayBuffer()
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
