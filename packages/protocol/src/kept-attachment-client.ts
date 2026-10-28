import { blobIdFor, contentHash, decryptBlob, deriveBlobKeys, encryptBlob } from './blob.ts'
import { isKeptRoomKeys, type KeptRoomKeys } from './kept-access.ts'

const MAX_BLOB_BYTES = 10 * 1024 * 1024
const ENCRYPTION_OVERHEAD = 28
const DEADLINE_MS = 30_000
const RETRY_MS = 250
const MAX_ATTEMPTS = 12

export type KeptAttachmentResult = { hash: string; disposition: 'stored' | 'reused' }
export type KeptAttachmentOptions = {
  url: string
  keys: KeptRoomKeys
  fetch?: typeof fetch
  timeoutMs?: number
}

async function readCiphertext(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (response.status !== 200 || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error('existing attachment unavailable')
  }
  const data = new Uint8Array(MAX_BLOB_BYTES)
  const reader = response.body.getReader()
  const onAbort = () => {
    void reader.cancel().catch(() => {})
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  let size = 0,
    chunks = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      if (++chunks > 16384) throw new Error('too many attachment chunks')
      if (part.value.length > data.length - size) throw new Error('existing attachment too large')
      data.set(part.value, size)
      size += part.value.length
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return data.slice(0, size)
}

// This v6 client is internal and does not expose or announce an attachment.
// The caller must retain plaintext locally until the containing edit is saved.
export class KeptAttachmentClient {
  private readonly base: string
  private readonly fetcher: typeof fetch
  private readonly timeoutMs: number
  constructor(private readonly options: KeptAttachmentOptions) {
    if (
      !isKeptRoomKeys(options.keys) ||
      options.keys.access !== 'edit' ||
      !options.keys.editAdmission
    )
      throw new Error('editor access required')
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > DEADLINE_MS)
    )
      throw new Error('invalid attachment timeout')
    this.timeoutMs = options.timeoutMs ?? DEADLINE_MS
    const url = new URL(options.url)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error('invalid kept endpoint')
    url.pathname = `${url.pathname.replace(/\/$/, '')}/internal/kept/${options.keys.roomId}/blobs/`
    this.base = url.toString()
    this.fetcher = options.fetch ?? fetch
  }

  async upload(plaintext: Uint8Array, signal?: AbortSignal): Promise<KeptAttachmentResult> {
    if (!plaintext.length || plaintext.length > MAX_BLOB_BYTES - ENCRYPTION_OVERHEAD)
      throw new Error('invalid attachment size')
    if (signal?.aborted) throw new Error('attachment upload interrupted')
    const input = Uint8Array.from(plaintext)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const deadline = new Promise<never>((_, reject) => {
      const stop = () => {
        controller.abort()
        reject(new Error('attachment upload interrupted'))
      }
      onAbort = stop
      if (signal?.aborted) stop()
      else signal?.addEventListener('abort', stop, { once: true })
      timer = setTimeout(stop, this.timeoutMs)
    })
    const assertActive = () => {
      if (controller.signal.aborted) throw new Error('attachment upload interrupted')
    }
    const delay = () => new Promise<void>((resolve) => setTimeout(resolve, RETRY_MS))
    const work = async (): Promise<KeptAttachmentResult> => {
      assertActive()
      const keys = await deriveBlobKeys(
        this.options.keys.frameSecret,
        this.options.keys.editAdmission!,
      )
      const hash = await contentHash(input)
      const id = await blobIdFor(keys, hash)
      const ciphertext = await encryptBlob(keys, input)
      const url = this.base + id
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        assertActive()
        let response: Response
        try {
          response = await this.fetcher(url, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${this.options.keys.editAdmission}` },
            body: Uint8Array.from(ciphertext).buffer,
            signal: controller.signal,
            redirect: 'manual',
            cache: 'no-store',
          })
        } catch (error) {
          assertActive()
          if (attempt + 1 === MAX_ATTEMPTS) throw error
          await delay()
          continue
        }
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {})
          assertActive()
        }
        if (response.status === 204) return { hash, disposition: 'stored' }
        void response.body?.cancel().catch(() => {})
        if (response.status !== 409) throw new Error('attachment upload refused')
        const existing = await this.fetcher(url, {
          headers: { Authorization: `Bearer ${this.options.keys.readAdmission}` },
          signal: controller.signal,
          redirect: 'manual',
          cache: 'no-store',
        })
        if (controller.signal.aborted) {
          void existing.body?.cancel().catch(() => {})
          assertActive()
        }
        if (existing.status === 404 && attempt + 1 < MAX_ATTEMPTS) {
          void existing.body?.cancel().catch(() => {})
          await delay()
          continue
        }
        const recovered = await decryptBlob(
          keys,
          await readCiphertext(existing, controller.signal),
          hash,
        )
        assertActive()
        if (recovered.length !== input.length || !recovered.every((v, i) => v === input[i]))
          throw new Error('attachment does not match')
        return { hash, disposition: 'reused' }
      }
      throw new Error('existing attachment unavailable')
    }
    try {
      return await Promise.race([work(), deadline])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
  }
}
