import { deriveKeptRoomKeys, type KeptLinkSecrets } from './kept-access.ts'
import { KeptOutbox } from './kept-outbox.ts'
import type { KeptRecordContext } from './kept-record.ts'

export type KeptSendResult =
  | { status: 'idle' }
  | { status: 'relay-accepted'; sender: string; sequence: number; relaySequence: number }
export type KeptOutboxSenderOptions = {
  url: string
  link: KeptLinkSecrets
  context: KeptRecordContext
  sender: string
  outbox: KeptOutbox
  fetch?: typeof fetch
}

async function responseText(response: Response): Promise<string> {
  if (response.status !== 200 || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error('kept append refused')
  }
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let length = 0,
    parts = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      if (++parts > 1024) throw new Error('too many response chunks')
      length += part.value.length
      if (length > 1024) throw new Error('kept append response too large')
      chunks.push(part.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

// The caller supplies a context authenticated by a checkpoint. A relay ACK
// only records its response; it does not prove an untrusted relay kept data.
export class KeptOutboxSender {
  private readonly endpoint: string
  private readonly fetcher: typeof fetch
  private readonly context: KeptRecordContext
  private readonly link: KeptLinkSecrets
  constructor(private readonly options: KeptOutboxSenderOptions) {
    if (options.link.access === 'read') throw new Error('writer access required')
    const url = new URL(options.url)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('invalid kept endpoint')
    if (
      !/^[A-Za-z0-9_-]{22}$/.test(options.context.roomId) ||
      options.context.epoch.length !== 32 ||
      options.context.epoch.every((x) => x === 0) ||
      !Number.isSafeInteger(options.context.generation) ||
      options.context.generation < 1
    )
      throw new Error('invalid kept context')
    url.pathname = `${url.pathname.replace(/\/$/, '')}/internal/kept/${options.context.roomId}/append`
    this.endpoint = url.toString()
    this.context = { ...options.context, epoch: Uint8Array.from(options.context.epoch) }
    this.link = structuredClone(options.link)
    this.fetcher = options.fetch ?? ((...args) => fetch(...args))
  }
  async enqueue(message: Uint8Array): Promise<number> {
    return this.options.outbox.enqueue(this.link, this.context.roomId, this.options.sender, message)
  }
  async sendNext(signal?: AbortSignal): Promise<KeptSendResult> {
    const operations = await this.options.outbox.operations(
      this.link,
      this.context.roomId,
      this.options.sender,
    )
    const next = operations.find((op) => !op.acknowledged)
    if (!next) return { status: 'idle' }
    const item = await this.options.outbox.prepare(
      this.link,
      this.context,
      this.options.sender,
      next.sequence,
    )
    if (item.acknowledged) return { status: 'idle' }
    const keys = await deriveKeptRoomKeys(this.link, this.context.roomId)
    const token = this.link.access === 'edit' ? keys.editAdmission : keys.commentAdmission
    if (!token) throw new Error('writer admission unavailable')
    if (signal?.aborted) throw new Error('kept append interrupted')
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const deadline = new Promise<never>((_, reject) => {
      const stop = () => {
        controller.abort()
        reject(new Error('kept append interrupted'))
      }
      onAbort = stop
      if (signal?.aborted) stop()
      else signal?.addEventListener('abort', stop, { once: true })
      timer = setTimeout(stop, 30_000)
    })
    let text: string
    try {
      text = await Promise.race([
        (async () => {
          if (controller.signal.aborted) throw new Error('kept append interrupted')
          const response = await this.fetcher(this.endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'X-Pedit-Epoch': item.epoch },
            body: Uint8Array.from(item.ciphertext).buffer,
            signal: controller.signal,
            redirect: 'manual',
            cache: 'no-store',
          })
          return responseText(response)
        })(),
        deadline,
      ])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    }
    const value: unknown = JSON.parse(text)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).join() !== 'sequence' ||
      JSON.stringify(value) !== text ||
      !('sequence' in value) ||
      typeof value.sequence !== 'number' ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1
    )
      throw new Error('invalid kept append response')
    await this.options.outbox.acknowledge(this.link, this.context.roomId, item)
    return {
      status: 'relay-accepted',
      sender: item.sender,
      sequence: item.sequence,
      relaySequence: value.sequence,
    }
  }
}
