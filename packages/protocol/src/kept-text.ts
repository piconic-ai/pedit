import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import type { RoomKeys } from './access.ts'
import { decrypt, encrypt } from './cipher.ts'
import { type FileEntry, metaTarget } from './files.ts'
import { MAX_FRAME_BYTES } from './frame.ts'
import { checkMetaUpdate } from './meta.ts'
import { checkPath, MAX_PATH_BYTES } from './path.ts'

const DOMAIN = new TextEncoder().encode('pedit kept text v1\0')
const SNAPSHOT_DOMAIN = new TextEncoder().encode('pedit kept snapshot v1\0')
const BUNDLE_DOMAIN = new TextEncoder().encode('pedit kept files snapshot v1\0')
const FILE_DOMAIN = new TextEncoder().encode('pedit kept file update v1\0')
const LIMIT = 8 * 1024 * 1024
/** Text files in a kept room; the comments docs paired with them do not count. */
const MAX_KEPT_FILES = 64
export class KeptTextClosedError extends Error {
  /** The host closed the room, rather than it reaching its deadline. */
  readonly byHost: boolean
  constructor(byHost = false) {
    super(byHost ? 'kept room closed by its host' : 'kept room expired')
    this.byHost = byHost
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

export type KeptTextState = {
  hostAway: boolean
  keepUntil: number
  logEntries: number
  skipped: number
  after: number
  filename: string | null
  files: readonly FileEntry[]
}
export class KeptTextClient {
  readonly state: KeptTextState = {
    hostAway: false,
    keepUntil: 0,
    logEntries: 0,
    skipped: 0,
    after: 0,
    filename: null,
    files: [],
  }
  private readonly url: string
  private readonly abort = new AbortController()
  private readonly sender = crypto.randomUUID()
  private work: Promise<void> = Promise.resolve()
  private readonly pending: FileUpdate[] = []
  private readonly docs = new Map<number, Y.Doc>()
  private readonly records = new Map<number, (update: Uint8Array, origin: unknown) => void>()
  private bundled = false
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
    this.docs.set(0, options.doc)
    this.listen(0, options.doc)
  }
  getDoc(id: number): Y.Doc | undefined {
    return this.docs.get(id)
  }
  private listen(id: number, doc: Y.Doc): void {
    const record = (update: Uint8Array, origin: unknown) => this.record(id, update, origin)
    this.records.set(id, record)
    doc.on('update', record)
  }
  private record(id: number, update: Uint8Array, origin: unknown): void {
    if (origin === this) return
    if (this.options.keys.access !== 'edit') {
      this.denied = true
      return
    }
    this.pending.push({ id, update: Uint8Array.from(update) })
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
      const bases = new Map([...this.docs].map(([id, doc]) => [id, copyDoc(doc)])),
        results = new Map<number, Y.Doc>()
      let display = {
        filename: this.state.filename,
        files: this.state.files,
        bundled: this.bundled,
      }
      try {
        if (value.snapshot !== undefined)
          display = this.snapshotBases(await this.open(value.snapshot, true), bases)
        const skipped = await this.logEntries(value.entries, bases, results)
        this.abort.signal.throwIfAborted()
        this.commitDocs(results)
        this.state.skipped += skipped
        this.state.filename = display.filename
        this.state.files = display.files
        this.bundled = display.bundled
      } finally {
        for (const doc of bases.values()) doc.destroy()
        for (const doc of results.values()) doc.destroy()
      }
      this.loaded = true
      this.etag = response.headers.get('ETag')
      this.metadata(value)
    })
  }
  private snapshotBases(opened: OpenedSnapshot, bases: Map<number, Y.Doc>) {
    if (this.bundled && (opened.kind !== 'bundle' || !sameFiles(this.state.files, opened.files)))
      throw new Error('changed kept manifest')
    const snapshots =
      opened.kind === 'bundle'
        ? opened.files
        : [{ id: 0, path: opened.filename, update: opened.update }]
    // A file whose path is the metadata path of another is that file's comments.
    const paths = new Set(snapshots.map((file) => file.path))
    const isMeta = (path: string | null) => {
      const target = path === null ? undefined : metaTarget(path)
      return target !== undefined && paths.has(target)
    }
    const listed = snapshots.flatMap((file) =>
      file.path === null
        ? []
        : [{ id: file.id, path: file.path, format: isMeta(file.path) ? 'meta' : 'text' }],
    )
    for (const file of snapshots) {
      let base = bases.get(file.id)
      const comments = isMeta(file.path)
      if (base && kindOf(base) !== (comments ? 'comments' : 'content'))
        throw new Error('changed kept manifest')
      if (!base) {
        base = declare(new Y.Doc(), comments)
        bases.set(file.id, base)
      }
      mergeSnapshot(base, file.update)
    }
    return {
      filename: snapshots[0]?.path ?? null,
      files: sameFiles(this.state.files, listed) ? this.state.files : listed,
      bundled: opened.kind === 'bundle',
    }
  }
  private async logEntries(
    entries: Snapshot['entries'],
    bases: ReadonlyMap<number, Y.Doc>,
    results: Map<number, Y.Doc>,
  ): Promise<number> {
    let skipped = 0
    const updates = new Map<number, Uint8Array[]>()
    for (const entry of entries) {
      if (entry.id <= this.state.after) continue
      try {
        const opened = await this.open(entry.body)
        if (!bases.has(opened.id)) throw new Error('unknown kept file')
        const list = updates.get(opened.id) ?? []
        list.push(opened.update)
        updates.set(opened.id, list)
      } catch {
        skipped++
      }
    }
    for (const [id, base] of bases) {
      const result = this.entries(base, updates.get(id) ?? [])
      results.set(id, result.doc)
      skipped += result.skipped
    }
    return skipped
  }
  private commitDocs(results: ReadonlyMap<number, Y.Doc>): void {
    for (const [id, result] of results) {
      let doc = this.docs.get(id)
      if (!doc) {
        doc = declare(new Y.Doc(), kindOf(result) === 'comments')
        this.docs.set(id, doc)
        this.listen(id, doc)
      }
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(result), this)
    }
  }
  private entries(base: Y.Doc, entries: readonly Uint8Array[]): { doc: Y.Doc; skipped: number } {
    let probe = copyDoc(base),
      skipped = 0
    const accepted: Uint8Array[] = []
    try {
      for (const update of entries) {
        try {
          const next = trial(probe, update)
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
    const first = this.pending[0]
    if (!first) throw new Error('missing kept edit')
    let contiguous = 1
    while (contiguous < count && this.pending[contiguous]?.id === first.id) contiguous++
    count = contiguous
    const domain = this.bundled || first.id !== 0 ? FILE_DOMAIN : DOMAIN
    const limit = MAX_FRAME_BYTES - domain.length - 64 - 28 - (domain === FILE_DOMAIN ? 4 : 0)
    const merge = (length: number) =>
      Y.mergeUpdates(this.pending.slice(0, length).map((entry) => entry.update))
    let low = 1,
      high = count - 1,
      fit = count,
      update: Uint8Array | undefined = merge(count)
    if (update.length > limit) {
      update = undefined
      fit = 0
    }
    if (update) high = 0
    while (low <= high) {
      const mid = Math.floor((low + high) / 2),
        merged = merge(mid)
      if (merged.length <= limit) {
        fit = mid
        update = merged
        low = mid + 1
      } else high = mid - 1
    }
    if (!update) throw new Error('kept edit too large')
    let payload = update
    if (domain === FILE_DOMAIN) {
      payload = new Uint8Array(4 + update.length)
      new DataView(payload.buffer).setUint32(0, first.id)
      payload.set(update, 4)
    }
    const message = join(domain, payload)
    const signature = new Uint8Array(
      await crypto.subtle.sign('Ed25519', signer.key, Uint8Array.from(message)),
    )
    return { body: await encrypt(this.options.keys.frameKey, join(message, signature)), count: fit }
  }
  close(): void {
    this.abort.abort()
    for (const [id, doc] of this.docs) {
      const record = this.records.get(id)
      if (record) doc.off('update', record)
      if (id !== 0) doc.destroy()
    }
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
      if (response.status === 410) throw new KeptTextClosedError(response.headers.get('X-Pedit-Closed') === 'host')
      throw new Error('kept request refused')
    }
    return response
  }
  private open(value: string, snapshot: true): Promise<OpenedSnapshot>
  private open(value: string, snapshot?: false): Promise<FileUpdate>
  private async open(value: string, snapshot = false): Promise<OpenedSnapshot | FileUpdate> {
    if (value.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4) throw new Error('kept frame too large')
    const decoded = atob(value)
    if (btoa(decoded) !== value) throw new Error('invalid kept frame')
    const ciphertext = Uint8Array.from(decoded, (char) => char.charCodeAt(0))
    if (ciphertext.length > MAX_FRAME_BYTES) throw new Error('kept frame too large')
    const plain = await decrypt(this.options.keys.frameKey, ciphertext)
    const message = plain.subarray(0, plain.length - 64)
    if (
      plain.length <= 64 ||
      !(await crypto.subtle.verify(
        'Ed25519',
        this.options.keys.editKey,
        Uint8Array.from(plain.subarray(plain.length - 64)),
        Uint8Array.from(message),
      ))
    )
      throw new Error('invalid kept signature')
    return snapshot ? decodeSnapshot(message) : decodeUpdate(message)
  }
}
type FileUpdate = { id: number; update: Uint8Array }
type BundleFile = FileUpdate & { path: string }
type OpenedSnapshot =
  | { kind: 'bundle'; files: BundleFile[] }
  | { kind: 'legacy'; filename: string | null; update: Uint8Array }
function payloadFor(message: Uint8Array, domain: Uint8Array): Uint8Array | undefined {
  return domain.every((byte, i) => message[i] === byte) ? message.slice(domain.length) : undefined
}
function decodeUpdate(message: Uint8Array): FileUpdate {
  const payload = payloadFor(message, FILE_DOMAIN)
  if (payload) {
    if (payload.length <= 4) throw new Error('invalid kept file update')
    return {
      id: new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0),
      update: payload.slice(4),
    }
  }
  const legacy = payloadFor(message, DOMAIN)
  if (!legacy?.length) throw new Error('invalid kept domain')
  return { id: 0, update: legacy }
}
function decodeSnapshot(message: Uint8Array): OpenedSnapshot {
  const bundle = payloadFor(message, BUNDLE_DOMAIN)
  if (bundle) return { kind: 'bundle', files: decodeBundle(bundle) }
  const payload = payloadFor(message, SNAPSHOT_DOMAIN)
  if (payload) {
    if (payload.length < 2) throw new Error('invalid kept snapshot')
    const size = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0)
    if (size < 1 || size > 4096 || size >= payload.length - 2)
      throw new Error('invalid kept filename')
    const filename = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      payload.subarray(2, 2 + size),
    )
    if (filename === '.' || filename === '..' || /[/\\\0]/.test(filename))
      throw new Error('invalid kept filename')
    return { kind: 'legacy', filename, update: payload.slice(2 + size) }
  }
  const legacy = payloadFor(message, DOMAIN)
  if (!legacy?.length) throw new Error('invalid kept snapshot domain')
  return { kind: 'legacy', filename: null, update: legacy }
}
function mergeSnapshot(base: Y.Doc, update: Uint8Array): void {
  const empty = declare(new Y.Doc(), kindOf(base) === 'comments')
  let snapshot: Y.Doc | undefined
  try {
    snapshot = trial(empty, update)
    if (incomplete(snapshot)) throw new Error('invalid kept snapshot')
    Y.applyUpdate(base, Y.encodeStateAsUpdate(snapshot))
  } finally {
    empty.destroy()
    snapshot?.destroy()
  }
}
function sameFiles(
  a: readonly Pick<FileEntry, 'id' | 'path'>[],
  b: readonly Pick<FileEntry, 'id' | 'path'>[],
): boolean {
  return (
    a.length === b.length && a.every((file, i) => file.id === b[i]?.id && file.path === b[i]?.path)
  )
}
function decodeBundle(payload: Uint8Array): BundleFile[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const count = view.getUint16(0),
    files: BundleFile[] = [],
    ids = new Set<number>(),
    paths = new Set<string>()
  if (count < 1 || count > 2 * MAX_KEPT_FILES) throw new Error('invalid kept file count')
  let at = 2
  for (let i = 0; i < count; i++) {
    const id = view.getUint32(at)
    at += 4
    const size = view.getUint16(at)
    at += 2
    if (size < 1 || size > MAX_PATH_BYTES || at + size > payload.length)
      throw new Error('invalid kept path')
    const path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      payload.subarray(at, at + size),
    )
    at += size
    const length = view.getUint32(at)
    at += 4
    if (
      (i === 0 && id !== 0) ||
      ids.has(id) ||
      paths.has(path) ||
      checkPath(path) ||
      length === 0 ||
      at + length > payload.length
    )
      throw new Error('invalid kept file')
    ids.add(id)
    paths.add(path)
    files.push({ id, path, update: payload.slice(at, at + length) })
    at += length
  }
  // The cap counts text files; their paired metadata docs come on top.
  if (files.filter((file) => metaTarget(file.path) === undefined).length > MAX_KEPT_FILES)
    throw new Error('invalid kept file count')
  if (at !== payload.length) throw new Error('invalid kept bundle trailing bytes')
  return files
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
/** A kept file's doc has one root: its text, or the comments paired with it. */
function kindOf(doc: Y.Doc): 'content' | 'comments' {
  return doc.share.has('comments') ? 'comments' : 'content'
}
function declare(doc: Y.Doc, comments: boolean): Y.Doc {
  if (comments) doc.getMap('comments')
  else doc.getText('content')
  return doc
}
function copyDoc(doc: Y.Doc): Y.Doc {
  const copy = declare(new Y.Doc(), kindOf(doc) === 'comments')
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}
function trial(base: Y.Doc, update: Uint8Array): Y.Doc {
  // Anyone with the edit key may log an update: comments are checked as in a live room.
  const refusal = kindOf(base) === 'comments' ? checkMetaUpdate(base, update) : null
  if (refusal) throw new Error('invalid kept comments')
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
