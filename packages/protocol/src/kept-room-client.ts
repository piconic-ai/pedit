import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import { decodeFiles } from './files.ts'
import { MAX_FRAME_BYTES } from './frame.ts'
import { isKeptRoomKeys, type KeptRoomKeys } from './kept-access.ts'
import { type KeptCheckpointContext, openKeptCheckpoint } from './kept-checkpoint.ts'
import { checkKeptCommentsState } from './kept-comments-schema.ts'
import { KeptLedger } from './kept-ledger.ts'
import {
  checkKeptReadAnchor,
  type KeptReadAnchor,
  type KeptReadSnapshot,
  keptReadSessionForCleanup,
  parseKeptReadPage,
  parseKeptReadSnapshot,
} from './kept-read-wire.ts'
import { openKeptRecord } from './kept-record.ts'
import { decodeKeptTextPayload } from './kept-text-payload.ts'
import { checkKeptTextState } from './kept-text-schema.ts'
import { decodeMessage, MessageType } from './message.ts'

// A host-signed checkpoint, distinct from the provisional tail below. It is
// authenticated but does not prove freshness or tail completeness.
export type KeptAuthenticatedCheckpoint = Readonly<{
  kind: 'authenticated-checkpoint'
  context: Readonly<KeptCheckpointContext>
  metadataId: number
  textState: Uint8Array
  commentsState: Uint8Array
}>

export type KeptReadInspection = {
  checkpoint: KeptAuthenticatedCheckpoint
  status: 'tail-unverified'
  applicable: false
  generation: number
  tail: number
  records: number
  textState: Uint8Array
  commentsState: Uint8Array
}
export type KeptRoomClientOptions = {
  url: string
  keys: KeptRoomKeys
  fetch?: typeof fetch
  anchor?: KeptReadAnchor
  // The caller must check the complete attachment inventory for this read.
  // Absence of a verifier or an indeterminate result fails closed.
  attachmentInventory?: (text: string) => Promise<'none' | 'present' | 'unverified'>
}
// Match MaxKeptCheckpointReceipts in internal/protocol/kept_read_client.go.
const maxCheckpointReceipts = 10000
const maxEntries = 1024
const maxBytes = 16 * MAX_FRAME_BYTES
const decode64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

class KeptReadRefused extends Error {
  readonly retryMs: number
  constructor(response: Response) {
    super(response.status === 429 ? 'kept read rate limited' : 'kept read refused')
    const value = response.headers.get('Retry-After') ?? '60'
    const seconds = /^[0-9]+$/.test(value) ? Number(value) : 0
    this.retryMs =
      response.status === 429 && Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 60
        ? seconds * 1000
        : 0
    void response.body?.cancel().catch(() => {})
  }
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function boundedText(response: Response): Promise<string> {
  if (!response.ok || !response.body) throw new KeptReadRefused(response)
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > 2 * MAX_FRAME_BYTES) throw new Error('kept response too large')
      chunks.push(part.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    merged.set(chunk, at)
    at += chunk.length
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged)
}
function applyDocument(doc: Y.Doc, update: Uint8Array, allowed: string): void {
  const decoder = decoding.createDecoder(update)
  Y.readUpdate(decoder, doc)
  if (
    decoder.pos !== update.length ||
    doc.store.pendingStructs ||
    doc.store.pendingDs ||
    [...doc.share.keys()].some((name) => name !== allowed)
  )
    throw new Error('unsupported checkpoint or update')
  const state = Y.encodeStateAsUpdate(doc)
  if (!(allowed === 'content' ? checkKeptTextState(state) : checkKeptCommentsState(state)))
    throw new Error('unsupported kept state')
  if (allowed === 'content') {
    const text = doc.getText('content')
    if (
      text._map.size !== 0 ||
      text
        .toDelta()
        .some(
          (part: { insert: unknown; attributes?: Record<string, unknown> }) =>
            typeof part.insert !== 'string' ||
            (part.attributes && Object.keys(part.attributes).length !== 0),
        )
    )
      throw new Error('unsupported text structure')
  }
}

function applyRecord(
  record: { access: string; message: Uint8Array },
  text: Y.Doc,
  comments: Y.Doc,
  metaId: number,
): 'text' | 'comments' {
  const message = decodeMessage(record.message)
  let target: Y.Doc, allowed: string, inner: Uint8Array
  if (message.type === MessageType.Sync && record.access === 'edit') {
    target = text
    allowed = 'content'
    inner = message.payload
  } else if (message.type === MessageType.Files) {
    const file = decodeFiles(message.payload)
    if (file.kind !== 'doc' || file.file !== metaId || file.type !== MessageType.Sync)
      throw new Error('unsupported kept operation')
    target = comments
    allowed = 'comments'
    inner = file.payload
  } else throw new Error('unsupported kept operation')
  const decoder = decoding.createDecoder(inner)
  if (decoding.readVarUint(decoder) !== 2) throw new Error('unsupported kept sync')
  const update = decoding.readVarUint8Array(decoder)
  if (!update.length || decoder.pos !== inner.length) throw new Error('invalid kept sync')
  applyDocument(target, update, allowed)
  return target === text ? 'text' : 'comments'
}

export function keptReadAdmission(keys: KeptRoomKeys): string {
  const token =
    keys.access === 'edit'
      ? keys.editAdmission
      : keys.access === 'comment'
        ? keys.commentAdmission
        : keys.readAdmission
  if (!token) throw new Error('missing kept admission')
  return token
}

// KeptRoomClient only inspects a fixed read. It never changes the editor,
// acknowledges a log, or asserts that the relay supplied the complete tail.
export class KeptRoomClient {
  private readonly endpoint: string
  private readonly fetcher: typeof fetch
  private readonly opts: KeptRoomClientOptions
  constructor(input: KeptRoomClientOptions) {
    const opts = { ...input, anchor: input.anchor ? { ...input.anchor } : undefined }
    this.opts = opts
    if (!isKeptRoomKeys(opts.keys)) throw new Error('invalid kept keys')
    const url = new URL(opts.url)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error('invalid kept endpoint')
    url.pathname = `${url.pathname.replace(/\/$/, '')}/internal/kept/${opts.keys.roomId}/read`
    this.endpoint = url.toString()
    this.fetcher = opts.fetch ?? ((...args) => fetch(...args))
  }
  async inspect(signal?: AbortSignal): Promise<KeptReadInspection> {
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    // The relay's fixed read expires after five minutes.
    const timer = setTimeout(() => controller.abort(), 4 * 60 * 1000)
    try {
      return await this.inspectSession(controller.signal)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  private async inspectSession(signal: AbortSignal): Promise<KeptReadInspection> {
    const auth = { Authorization: `Bearer ${keptReadAdmission(this.opts.keys)}` }
    let rateRetries = 0
    const get = async (method: string, session?: string, cursor?: string) => {
      const headers = new Headers(auth)
      if (session && cursor) {
        headers.set('X-Pedit-Read-Session', session)
        headers.set('X-Pedit-Read-Cursor', cursor)
      }
      for (;;) {
        signal.throwIfAborted()
        try {
          return await boundedText(
            await this.fetcher(this.endpoint, {
              method,
              headers,
              signal,
              redirect: 'manual',
              cache: 'no-store',
            }),
          )
        } catch (error) {
          if (!(error instanceof KeptReadRefused) || !error.retryMs || rateRetries >= 2) throw error
          rateRetries++
          await waitForRetry(error.retryMs, signal)
        }
      }
    }
    const raw = await get('POST')
    const session = keptReadSessionForCleanup(raw)
    try {
      const snapshot = parseKeptReadSnapshot(raw)
      return await this.inspectSnapshot(snapshot, get, signal)
    } finally {
      if (session) await this.cancelRead(auth, session)
    }
  }
  private async cancelRead(auth: { Authorization: string }, session: string): Promise<void> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.fetcher(this.endpoint, {
          method: 'DELETE',
          headers: { ...auth, 'X-Pedit-Read-Session': session },
          signal: controller.signal,
          redirect: 'manual',
          cache: 'no-store',
        }).then((response) => {
          void response.body?.cancel().catch(() => {})
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            controller.abort()
            resolve()
          }, 2000)
        }),
      ])
    } catch {
      // Session expiry is the fallback if cleanup cannot reach the relay.
    } finally {
      clearTimeout(timer)
    }
  }
  private async inspectSnapshot(
    snapshot: KeptReadSnapshot,
    get: (method: string, session?: string, cursor?: string) => Promise<string>,
    signal?: AbortSignal,
  ): Promise<KeptReadInspection> {
    if (this.opts.anchor) checkKeptReadAnchor(snapshot, this.opts.anchor)
    const epoch = Uint8Array.from(snapshot.epoch.match(/../g)!, (x) => Number.parseInt(x, 16))
    const context = { roomId: this.opts.keys.roomId, epoch, generation: snapshot.generation }
    const plain = await openKeptCheckpoint(
      this.opts.keys,
      { ...context, cutoff: snapshot.cutoff },
      decode64(snapshot.ciphertext),
    )
    const payload = decodeKeptTextPayload(plain, maxCheckpointReceipts)
    const text = payload.documents.get(0)
    const meta = payload.manifest.find((f) => f.format === 'meta')
    const comments = meta && payload.documents.get(meta.id)
    if (!text || !comments) throw new Error('unsupported checkpoint')
    const textDoc = new Y.Doc(),
      commentsDoc = new Y.Doc()
    try {
      applyDocument(textDoc, text, 'content')
      applyDocument(commentsDoc, comments, 'comments')
      // This ledger is provisional: the authenticated baseline stays unchanged.
      let ledger = KeptLedger.restore(
          maxCheckpointReceipts + maxEntries,
          payload.ledger.snapshot(),
        ),
        cursor = snapshot.cursor,
        after = snapshot.cutoff,
        count = 0,
        total = 0,
        textChanged = false
      for (;;) {
        let raw: string
        try {
          raw = await get('GET', snapshot.session, cursor)
        } catch (err) {
          if (signal?.aborted || err instanceof KeptReadRefused) throw err
          raw = await get('GET', snapshot.session, cursor)
        }
        const page = parseKeptReadPage(raw, after, snapshot.tail)
        const next = await this.applyEntries(
          page.entries,
          context,
          ledger,
          textDoc,
          commentsDoc,
          meta.id,
          count,
          total,
          textChanged,
        )
        ledger = next.ledger
        count = next.count
        total = next.total
        textChanged = next.textChanged
        after = page.entries.at(-1)?.sequence ?? after
        if (page.next === null) break
        if (page.next === cursor) throw new Error('repeated kept read cursor')
        cursor = page.next
      }
      const content = textDoc.getText('content').toString()
      if (/assets\/[0-9a-f]{32}\.(?:png|jpg|gif|webp)/.test(content))
        throw new Error('unsupported kept attachments')
      if (
        textChanged &&
        (!this.opts.attachmentInventory ||
          (await this.opts.attachmentInventory(content)) !== 'none')
      )
        throw new Error('kept attachment inventory unverified')
      return {
        checkpoint: {
          kind: 'authenticated-checkpoint',
          context: { ...context, epoch: Uint8Array.from(context.epoch), cutoff: snapshot.cutoff },
          metadataId: meta.id,
          textState: Uint8Array.from(text),
          commentsState: Uint8Array.from(comments),
        },
        status: 'tail-unverified',
        applicable: false,
        generation: snapshot.generation,
        tail: snapshot.tail,
        records: count,
        textState: Y.encodeStateAsUpdate(textDoc),
        commentsState: Y.encodeStateAsUpdate(commentsDoc),
      }
    } finally {
      textDoc.destroy()
      commentsDoc.destroy()
    }
  }
  private async applyEntries(
    entries: ReturnType<typeof parseKeptReadPage>['entries'],
    context: Parameters<typeof openKeptRecord>[1],
    ledger: ReturnType<typeof decodeKeptTextPayload>['ledger'],
    textDoc: Y.Doc,
    commentsDoc: Y.Doc,
    metaId: number,
    count: number,
    total: number,
    textChanged: boolean,
  ) {
    for (const entry of entries) {
      const sealed = decode64(entry.ciphertext)
      total += sealed.length
      if (++count > maxEntries || total > maxBytes) throw new Error('kept read capacity reached')
      const record = await openKeptRecord(this.opts.keys, context, sealed)
      const decision = await ledger.inspect(record)
      if (decision.decision === 'next') {
        if (applyRecord(record, textDoc, commentsDoc, metaId) === 'text') textChanged = true
        ledger = ledger.commit(decision, 'applied')
      } else if (decision.decision !== 'duplicate') throw new Error('invalid kept ledger sequence')
    }
    return { ledger, count, total, textChanged }
  }
}
