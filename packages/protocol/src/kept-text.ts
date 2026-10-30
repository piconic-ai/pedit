import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import type { RoomKeys } from './access.ts'
import { decrypt, encrypt } from './cipher.ts'
import { MAX_FRAME_BYTES } from './frame.ts'

const DOMAIN = new TextEncoder().encode('pedit kept text v1\0')
const LIMIT = 8 * 1024 * 1024
const UPDATE_LIMIT = MAX_FRAME_BYTES - DOMAIN.length - 64 - 28
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
  readonly state = { hostAway: false, keepUntil: 0, logEntries: 0, skipped: 0, after: 0 }
  private readonly url: string
  private readonly abort = new AbortController()
  private readonly sender = crypto.randomUUID()
  private work: Promise<void> = Promise.resolve()
  private readonly pending: Uint8Array[] = []
  private prepared: { body: Uint8Array; count: number } | undefined
  private loaded = false
  private etag: string | null = null
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
    this.pending.push(Uint8Array.from(update))
    this.options.onStatus?.('pending')
  }
  refresh(): Promise<void> {
    return this.run(async () => {
      const response = await this.request('GET')
      if (response.status === 304) {
        this.notModified(response)
        return
      }
      const value: unknown = JSON.parse(await boundedText(response))
      if (!isSnapshot(value) || value.tail < this.state.after)
        throw new Error('invalid kept response')
      const reset = !this.loaded || this.state.after < value.cutoff
      if (reset && value.snapshot === undefined) throw new Error('missing kept snapshot')
      let previous = value.snapshot === undefined ? this.state.after : value.cutoff
      for (const entry of value.entries) {
        if (entry.id <= previous || entry.id > value.tail) throw new Error('invalid kept entry')
        previous = entry.id
      }
      const base = copyDoc(this.options.doc)
      try {
        if (value.snapshot !== undefined) {
          const empty = new Y.Doc()
          let snapshot: Y.Doc | undefined
          try {
            snapshot = trial(empty, await this.open(value.snapshot))
            if (incomplete(snapshot)) throw new Error('invalid kept snapshot')
            Y.applyUpdate(base, Y.encodeStateAsUpdate(snapshot))
          } finally {
            empty.destroy()
            snapshot?.destroy()
          }
        }
        const result = await this.entries(
          base,
          value.entries.filter((entry) => entry.id > this.state.after),
        )
        try {
          this.abort.signal.throwIfAborted()
          Y.applyUpdate(this.options.doc, Y.encodeStateAsUpdate(result.doc), this)
          this.state.skipped += result.skipped
        } finally {
          result.doc.destroy()
        }
      } finally {
        base.destroy()
      }
      this.loaded = true
      this.etag = response.headers.get('ETag')
      this.metadata(value)
    })
  }
  private async entries(
    base: Y.Doc,
    entries: Snapshot['entries'],
  ): Promise<{ doc: Y.Doc; skipped: number }> {
    let probe = copyDoc(base),
      skipped = 0
    const accepted: Uint8Array[] = []
    try {
      for (const entry of entries) {
        try {
          const update = await this.open(entry.body),
            next = trial(probe, update)
          probe.destroy()
          probe = next
          accepted.push(update)
        } catch {
          skipped++
        }
      }
      while (incomplete(probe)) {
        const complete = accepted.filter((update) => integrated(probe, update))
        if (complete.length === accepted.length) complete.length = 0
        skipped += accepted.length - complete.length
        accepted.splice(0, accepted.length, ...complete)
        probe.destroy()
        probe = copyDoc(base)
        for (const update of accepted) Y.applyUpdate(probe, update)
      }
      return { doc: probe, skipped }
    } catch (error) {
      probe.destroy()
      throw error
    }
  }
  private notModified(response: Response): void {
    const h = response.headers,
      numeric = (name: string) => {
        const value = h.get(name)
        return value !== null && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN
      }
    const value = {
      cutoff: numeric('X-Pedit-Cutoff'),
      tail: numeric('X-Pedit-Tail'),
      hostAway: h.get('X-Pedit-Host-Away') === 'true',
      keepUntil: numeric('X-Pedit-Keep-Until'),
    }
    if (
      !this.loaded ||
      !this.etag ||
      response.headers.get('ETag') !== this.etag ||
      !validMetadata(value) ||
      !['true', 'false'].includes(h.get('X-Pedit-Host-Away') ?? '') ||
      value.tail !== this.state.after ||
      value.cutoff > this.state.after
    )
      throw new Error('invalid kept cache response')
    this.metadata(value)
  }
  private metadata(value: Metadata): void {
    Object.assign(this.state, {
      hostAway: value.hostAway,
      keepUntil: value.keepUntil,
      logEntries: value.tail - value.cutoff,
      after: value.tail,
    })
  }
  flush(): Promise<void> {
    return this.run(async () => {
      if (this.denied) throw new Error('edit link required')
      let remaining = this.pending.length
      while (remaining > 0) {
        this.prepared ??= await this.prepare(remaining)
        const response = await this.request('POST', this.prepared.body)
        void response.body?.cancel().catch(() => {})
        this.pending.splice(0, this.prepared.count)
        remaining -= this.prepared.count
        this.prepared = undefined
      }
      this.options.onStatus?.(this.pending.length ? 'pending' : 'kept')
    })
  }
  private async prepare(count: number): Promise<{ body: Uint8Array; count: number }> {
    const signer = this.options.keys.signer
    if (signer?.access !== 'edit') throw new Error('edit link required')
    let low = 1,
      high = count - 1,
      fit = count,
      update: Uint8Array | undefined = Y.mergeUpdates(this.pending.slice(0, count))
    if (update.length > UPDATE_LIMIT) {
      update = undefined
      fit = 0
    }
    if (update) high = 0
    while (low <= high) {
      const mid = Math.floor((low + high) / 2),
        merged = Y.mergeUpdates(this.pending.slice(0, mid))
      if (merged.length <= UPDATE_LIMIT) {
        fit = mid
        update = merged
        low = mid + 1
      } else high = mid - 1
    }
    if (!update) throw new Error('kept edit too large')
    const message = join(DOMAIN, update)
    const signature = new Uint8Array(
      await crypto.subtle.sign('Ed25519', signer.key, Uint8Array.from(message)),
    )
    return { body: await encrypt(this.options.keys.frameKey, join(message, signature)), count: fit }
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
    if (method === 'GET' && this.etag) headers.set('If-None-Match', this.etag)
    const response = await (this.options.fetch ?? fetch)(
      `${this.url}${method === 'POST' ? '/append' : `?after=${this.state.after}`}`,
      {
        method,
        headers,
        redirect: 'manual',
        cache: 'no-store',
        signal: this.abort.signal,
        body: body ? Uint8Array.from(body) : undefined,
      },
    )
    if (!response.ok && !(method === 'GET' && response.status === 304)) {
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
type Metadata = { cutoff: number; tail: number; hostAway: boolean; keepUntil: number }
type Snapshot = Metadata & { snapshot?: string; entries: { id: number; body: string }[] }
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function validMetadata(value: unknown): value is Metadata {
  return (
    object(value) &&
    typeof value.cutoff === 'number' &&
    Number.isSafeInteger(value.cutoff) &&
    value.cutoff >= 0 &&
    typeof value.tail === 'number' &&
    Number.isSafeInteger(value.tail) &&
    value.tail >= value.cutoff &&
    typeof value.hostAway === 'boolean' &&
    typeof value.keepUntil === 'number' &&
    Number.isSafeInteger(value.keepUntil) &&
    value.keepUntil >= 0
  )
}
function isSnapshot(value: unknown): value is Snapshot {
  return (
    validMetadata(value) &&
    (!('snapshot' in value) || typeof value.snapshot === 'string') &&
    'entries' in value &&
    Array.isArray(value.entries) &&
    value.entries.length <= 10000 &&
    value.entries.every(
      (entry: unknown) =>
        object(entry) &&
        typeof entry.id === 'number' &&
        Number.isSafeInteger(entry.id) &&
        typeof entry.body === 'string',
    )
  )
}
function incomplete(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null
}
function copyDoc(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc()
  copy.getText('content')
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}
function trial(base: Y.Doc, update: Uint8Array): Y.Doc {
  const copy = copyDoc(base)
  try {
    const decoder = decoding.createDecoder(update)
    Y.readUpdate(decoder, copy)
    if (decoder.pos !== update.length || copy.share.size > 1) throw new Error('invalid kept text')
    return copy
  } catch (error) {
    copy.destroy()
    throw error
  }
}
function integrated(doc: Y.Doc, update: Uint8Array): boolean {
  return Y.snapshotContainsUpdate(Y.snapshot(doc), update)
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
