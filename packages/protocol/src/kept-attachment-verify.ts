import { blobIdFor, decryptBlob, deriveBlobKeys } from './blob.ts'
import { isKeptRoomKeys, type KeptRoomKeys } from './kept-access.ts'
import { readKeptAttachmentCiphertext } from './kept-attachment-client.ts'

const PATH = /^assets\/([0-9a-f]{32})\.(png|jpg|gif|webp)$/
const MAX_TIMEOUT_MS = 30_000

export type KeptVerifiedAttachment = { path: string; bytes: Uint8Array }
export type KeptAttachmentVerifyOptions = {
  url: string
  keys: KeptRoomKeys
  fetch?: typeof fetch
  timeoutMs?: number
}

function matchesImage(bytes: Uint8Array, extension: string): boolean {
  const starts = (signature: readonly number[], offset = 0) =>
    signature.every((value, i) => bytes[offset + i] === value)
  switch (extension) {
    case 'png':
      return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpg':
      return starts([0xff, 0xd8, 0xff])
    case 'gif':
      return (
        starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      )
    case 'webp':
      return starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)
  }
  return false
}

// Verifies one known blob, not inventory completeness, tail freshness or durability.
export async function verifyKeptAttachment(
  options: KeptAttachmentVerifyOptions,
  path: string,
  signal?: AbortSignal,
): Promise<KeptVerifiedAttachment> {
  const match = PATH.exec(path)
  if (!match || !match[1] || !match[2]) throw new Error('invalid attachment path')
  if (!isKeptRoomKeys(options.keys)) throw new Error('invalid kept keys')
  const roomKeys = options.keys
  const fetcher = options.fetch ?? ((...args) => fetch(...args))
  const timeout = options.timeoutMs ?? MAX_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS)
    throw new Error('invalid attachment timeout')
  const url = new URL(options.url)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error('invalid kept endpoint')
  if (signal?.aborted) throw new Error('attachment verification interrupted')
  const hash = match[1]
  const extension = match[2]
  const expiresAt = performance.now() + timeout
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const deadline = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort()
      reject(new Error('attachment verification interrupted'))
    }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(abort, timeout)
  })
  const active = () => {
    if (controller.signal.aborted || performance.now() >= expiresAt) {
      controller.abort()
      throw new Error('attachment verification interrupted')
    }
  }
  const work = async () => {
    const keys = await deriveBlobKeys(roomKeys.frameSecret, roomKeys.readAdmission)
    active()
    const id = await blobIdFor(keys, hash)
    active()
    url.pathname = `${url.pathname.replace(/\/$/, '')}/internal/kept/${roomKeys.roomId}/blobs/${id}`
    const response = await fetcher(url.toString(), {
      headers: { Authorization: `Bearer ${roomKeys.readAdmission}` },
      signal: controller.signal,
      redirect: 'manual',
      cache: 'no-store',
    })
    try {
      active()
    } catch (error) {
      void response.body?.cancel().catch(() => {})
      throw error
    }
    const ciphertext = await readKeptAttachmentCiphertext(response, controller.signal, active, true)
    active()
    const bytes = await decryptBlob(keys, ciphertext, hash)
    active()
    if (!matchesImage(bytes, extension)) throw new Error('attachment type mismatch')
    active()
    return { path, bytes }
  }
  try {
    return await Promise.race([work(), deadline])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}
