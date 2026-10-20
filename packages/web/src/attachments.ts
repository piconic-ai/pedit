import {
  ADMISSION_HEADER,
  type Attachment,
  type BlobKeys,
  blobIdFor,
  contentHash,
  decryptBlob,
  encryptBlob,
  MAX_WANT_HASHES,
  type RoomStatus,
} from '@pedit/protocol'
import { ImageError, type ImageType, prepareImage, type Shrink, sniff } from './image.ts'
import { Store } from './store.ts'

/** What the host's pedit says about saving images, from its awareness state. */
export interface HostAttachments {
  /** The directory, beside the shared file, that links point into. */
  dir: string
  maxBytes: number
}

/** The server's cap on one attachment; the host may ask for less. */
export const MAX_BYTES = 10 * 1024 * 1024

type State = { [key: string]: unknown }

/**
 * Whether the host saves images, and where. Hosts before attachments say
 * nothing, and then nobody can add images.
 */
export function hostAttachments(states: Map<number, State>): HostAttachments | null {
  for (const state of states.values()) {
    if (state.role !== 'host') continue
    const a = state.attachments as { dir?: unknown; maxBytes?: unknown } | undefined
    if (!a || typeof a.dir !== 'string' || !/^[A-Za-z0-9._-]+$/.test(a.dir)) return null
    if (typeof a.maxBytes !== 'number' || !(a.maxBytes > 0)) return null
    return { dir: a.dir, maxBytes: Math.min(a.maxBytes, MAX_BYTES) }
  }
  return null
}

/**
 * Why images cannot be added right now, or null when they can. Before the
 * host's awareness state arrives, and while reconnecting, its absence says
 * nothing about its version.
 */
export function whyNoImages(
  status: RoomStatus,
  hostHere: boolean,
  host: HostAttachments | null,
): string | null {
  if (status === 'closed') return 'The session has ended.'
  if (status === 'full') return 'This room is full.'
  if (status === 'maintenance') return 'The relay is closed for maintenance.'
  if (status === 'client-outdated') return 'This page is out of date. Reload it first.'
  if (status === 'server-outdated') return 'The server is older than this page.'
  if (status === 'expired') return 'This room reached its time limit.'
  if (status === 'too-large') return 'The document is too large to share.'
  if (status === 'waiting') return 'The host is away. Try again once they are back.'
  if (status !== 'connected' || !hostHere) return 'Connecting to the host. Try again in a moment.'
  if (!host) return "The host's pedit is too old to save images."
  return null
}

/** A reason an image was not added, worded for the person who added it. */
export class AttachmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentError'
  }
}

const MESSAGES = {
  unsupported: "The host's pedit is too old to save images.",
  type: 'Only PNG, JPEG, GIF and WebP images can be added.',
  too_large: 'The image is too large to add.',
  unreadable: 'The image could not be read.',
  quota: 'This session cannot take more images.',
  closed: 'The session has ended.',
  failed: 'The image could not be uploaded. Try again.',
  timeout: 'The host did not answer, so the image was not added.',
  refused: 'The host could not save the image.',
} as const

// Reasons the host gives in `rejected` messages.
const REJECTED: Record<string, keyof typeof MESSAGES> = {
  type: 'type',
  too_large: 'too_large',
  quota: 'quota',
}

export interface AttachmentsOptions {
  roomId: string
  keys: BlobKeys
  /**
   * Sends an attachment message to the room: about `file`, the file an
   * image was added to in a room that shares several, or the one on screen.
   */
  send: (attachment: Attachment, file?: number) => void
  fetch?: typeof fetch
  shrink?: Shrink
  /** How long to wait for the host to save an upload. */
  storedTimeoutMs?: number
  /** How long to wait before retrying an upload the room cannot take yet. */
  retryDelayMs?: number
  /** How long to gather missing images into one `want`. */
  wantDelayMs?: number
  /** How long the host has to upload a wanted image before it counts as missing. */
  wantTimeoutMs?: number
  /** How many bytes of images to keep in memory. */
  cacheBytes?: number
}

/** What the preview shows for an image link (see preview.ts). */
export type ImageLookup = { url: string } | 'loading' | null

export interface ImageResolver {
  /** An attachment link's image, 'loading', or null for any other link. */
  lookup(src: string): ImageLookup
  /** Whether a URL is one of the images lookup handed out. */
  owns(url: string): boolean
  /** Called after each render: the links looked up since the last one are on screen. */
  rendered?(): void
}

interface Cached {
  url: string
  size: number
}

interface Pending {
  mime: string
  /** The file it was added to, in a room that shares several. */
  file: number | undefined
  promise: Promise<string>
  resolve: (path: string) => void
  reject: (error: AttachmentError) => void
}

const RETRIES = 5
const CACHE_BYTES = 64 * 1024 * 1024
const EXTENSIONS = new Set(['png', 'jpg', 'gif', 'webp'])

/**
 * Adds images to the room: uploads them encrypted, tells the room, and waits
 * for the host to save them. Only then does the link go into the document,
 * so it never points at a file that is not there.
 *
 * It also finds the images the document links to, for the preview: from
 * memory, from the room's blob store, or by asking the host to upload them
 * from its disk. They stay in memory only, and only for this page.
 */
export class Attachments implements ImageResolver {
  /** Images being added right now. */
  readonly uploading = new Store(0)
  /** Bumped whenever an image arrives, so the preview can show it. */
  readonly version = new Store(0)

  #opts: AttachmentsOptions
  #fetch: typeof fetch
  #pending = new Map<string, Pending>()
  #host: HostAttachments | null = null
  // Kept after the host leaves, so links still resolve from memory.
  #dir = 'assets'
  // In least recently used order.
  #cache = new Map<string, Cached>()
  #cachedBytes = 0
  #urls = new Set<string>()
  #loading = new Set<string>()
  // Announced while our own fetch was in flight: a 404 from it is stale.
  #announcedWhileLoading = new Set<string>()
  // Asked the host for, until it uploads them or the time runs out.
  #wanted = new Map<string, ReturnType<typeof setTimeout>>()
  // Content that does not match its name: missing for good.
  #missing = new Set<string>()
  // Failed on the way (offline, the room reconnecting, no answer): tried
  // again after the next reconnect.
  #failed = new Set<string>()
  // Looked up by the render in progress, and by the last finished one. The
  // cache never evicts these, or every render would fetch what the one
  // before evicted: the budget gives way to what the document shows.
  #seen = new Set<string>()
  #onScreen = new Set<string>()
  #wantQueue = new Set<string>()
  #wantTimer: ReturnType<typeof setTimeout> | undefined

  constructor(opts: AttachmentsOptions) {
    this.#opts = opts
    this.#fetch = opts.fetch ?? ((...args) => fetch(...args))
  }

  /** From the host's awareness state; null while it does not save images. */
  get host(): HostAttachments | null {
    return this.#host
  }

  set host(host: HostAttachments | null) {
    this.#host = host
    if (host) this.#dir = host.dir
  }

  lookup(src: string): ImageLookup {
    const match = new RegExp(`^${escapeRegExp(this.#dir)}/([0-9a-f]{32})\\.([a-z]+)$`).exec(src)
    const hash = match?.[1]
    if (!hash || !EXTENSIONS.has(match[2] ?? '')) return null
    this.#seen.add(hash)
    const cached = this.#cache.get(hash)
    if (cached) {
      this.#cache.delete(hash)
      this.#cache.set(hash, cached)
      return { url: cached.url }
    }
    if (this.#missing.has(hash) || this.#failed.has(hash)) return null
    void this.#load(hash)
    return 'loading'
  }

  rendered(): void {
    this.#onScreen = this.#seen
    this.#seen = new Set()
  }

  owns(url: string): boolean {
    return this.#urls.has(url)
  }

  /**
   * Adds an image; resolves with its path relative to the shared file. In a
   * room that shares several, `to` is the file it goes beside, whichever is
   * on screen by the time it is sent.
   */
  async upload(file: Blob, to?: number): Promise<string> {
    this.uploading.set(this.uploading.get() + 1)
    try {
      return await this.#upload(file, to)
    } finally {
      this.uploading.set(this.uploading.get() - 1)
    }
  }

  /** Handles an attachment message from the room. */
  handle(attachment: Attachment): void {
    if (attachment.kind === 'announce') {
      // Uploaded for someone who wanted it, maybe us.
      const hash = attachment.hash
      if (this.#loading.has(hash)) this.#announcedWhileLoading.add(hash)
      if (this.#wanted.has(hash) || this.#failed.has(hash)) {
        clearTimeout(this.#wanted.get(hash))
        this.#wanted.delete(hash)
        this.#failed.delete(hash)
        void this.#load(hash)
      }
    } else if (attachment.kind === 'stored') {
      this.#pending.get(attachment.hash)?.resolve(attachment.path)
    } else if (attachment.kind === 'rejected') {
      const reason = REJECTED[attachment.reason] ?? 'refused'
      this.#pending.get(attachment.hash)?.reject(new AttachmentError(MESSAGES[reason]))
    }
  }

  /**
   * Frames sent while disconnected are lost: announce what still waits, ask
   * again for what was wanted, and retry what failed on the way.
   */
  reconnected(): void {
    for (const [hash, p] of this.#pending) {
      this.#opts.send({ kind: 'announce', hash, mime: p.mime }, p.file)
    }
    // The host may have uploaded them while we were away, so look in the
    // room first; a 404 wants them again.
    for (const [hash, timer] of [...this.#wanted]) {
      clearTimeout(timer)
      this.#wanted.delete(hash)
      void this.#load(hash)
    }
    if (this.#failed.size > 0) {
      this.#failed.clear()
      this.version.set(this.version.get() + 1)
    }
  }

  async #upload(file: Blob, to: number | undefined): Promise<string> {
    const host = this.host
    if (!host) throw new AttachmentError(MESSAGES.unsupported)
    let image: Awaited<ReturnType<typeof prepareImage>>
    try {
      image = await prepareImage(
        new Uint8Array(await file.arrayBuffer()),
        host.maxBytes,
        this.#opts.shrink,
      )
    } catch (error) {
      if (error instanceof ImageError) throw new AttachmentError(MESSAGES[error.reason])
      throw error
    }
    const hash = await contentHash(image.bytes)
    const waiting = this.#pending.get(hash)
    if (waiting) return waiting.promise
    await this.#put(hash, await encryptBlob(this.#opts.keys, image.bytes))
    // Another upload of the same image may have got here first.
    const announced = this.#pending.get(hash)
    if (announced) return announced.promise
    const path = await this.#announce(hash, image.type, to)
    // Show it right away: no need to fetch what we just uploaded.
    this.#remember(hash, image.bytes, image.type)
    return path
  }

  async #load(hash: string): Promise<void> {
    if (this.#loading.has(hash) || this.#wanted.has(hash)) return
    // Loading until it is cached, wanted or given up on, so no render in
    // between starts a second fetch.
    this.#loading.add(hash)
    try {
      await this.#fetchImage(hash)
    } finally {
      this.#loading.delete(hash)
      this.#announcedWhileLoading.delete(hash)
    }
  }

  async #fetchImage(hash: string): Promise<void> {
    let data: Uint8Array
    try {
      const url = `/api/rooms/${this.#opts.roomId}/blobs/${await blobIdFor(this.#opts.keys, hash)}`
      const init: RequestInit = {
        headers: { [ADMISSION_HEADER]: this.#opts.keys.admission },
        redirect: 'error',
      }
      let res = await this.#fetch(url, init)
      // Uploaded while we were asking: ask once more before wanting it.
      if (res.status === 404 && this.#announcedWhileLoading.has(hash)) {
        res = await this.#fetch(url, init)
      }
      if (res.status === 404) {
        this.#want(hash)
        return
      }
      if (!res.ok) throw new Error(`blob: ${res.status}`)
      data = new Uint8Array(await res.arrayBuffer())
    } catch {
      this.#failed.add(hash)
      this.version.set(this.version.get() + 1)
      return
    }
    try {
      const bytes = await decryptBlob(this.#opts.keys, data, hash)
      const type = sniff(bytes)
      if (!type) throw new Error('not an image')
      this.#remember(hash, bytes, type)
    } catch {
      // Someone uploaded something else under its name.
      this.#missing.add(hash)
      this.version.set(this.version.get() + 1)
    }
  }

  // Missing images are gathered into one message; the host uploads the ones
  // it has and announces them.
  #want(hash: string): void {
    this.#wanted.set(
      hash,
      setTimeout(() => {
        this.#wanted.delete(hash)
        this.#failed.add(hash)
        this.version.set(this.version.get() + 1)
      }, this.#opts.wantTimeoutMs ?? 10_000),
    )
    this.#wantQueue.add(hash)
    this.#wantTimer ??= setTimeout(() => {
      this.#wantTimer = undefined
      const hashes = [...this.#wantQueue]
      this.#wantQueue.clear()
      for (let i = 0; i < hashes.length; i += MAX_WANT_HASHES) {
        this.#opts.send({ kind: 'want', hashes: hashes.slice(i, i + MAX_WANT_HASHES) })
      }
    }, this.#opts.wantDelayMs ?? 200)
  }

  #remember(hash: string, bytes: Uint8Array, type: ImageType): void {
    if (this.#cache.has(hash)) return
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }))
    this.#cache.set(hash, { url, size: bytes.length })
    this.#urls.add(url)
    this.#cachedBytes += bytes.length
    const limit = this.#opts.cacheBytes ?? CACHE_BYTES
    for (const [oldest, entry] of this.#cache) {
      if (this.#cachedBytes <= limit) break
      if (oldest === hash || this.#seen.has(oldest) || this.#onScreen.has(oldest)) continue
      this.#cache.delete(oldest)
      this.#urls.delete(entry.url)
      URL.revokeObjectURL(entry.url)
      this.#cachedBytes -= entry.size
    }
    this.version.set(this.version.get() + 1)
  }

  async #put(hash: string, body: Uint8Array): Promise<void> {
    const url = `/api/rooms/${this.#opts.roomId}/blobs/${await blobIdFor(this.#opts.keys, hash)}`
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await this.#fetch(url, {
          method: 'PUT',
          body: body as Uint8Array<ArrayBuffer>,
          headers: { [ADMISSION_HEADER]: this.#opts.keys.admission },
          redirect: 'error',
        })
      } catch {
        throw new AttachmentError(MESSAGES.failed)
      }
      if (res.ok) return
      // Someone is uploading the same image right now (409), or the room is
      // taking as many uploads as it can at once (503).
      if ((res.status === 409 || res.status === 503) && attempt < RETRIES) {
        await new Promise((r) => setTimeout(r, this.#opts.retryDelayMs ?? 500))
        continue
      }
      if (res.status === 410) throw new AttachmentError(MESSAGES.closed)
      if (res.status === 413) throw new AttachmentError(MESSAGES.too_large)
      if (res.status === 429) throw new AttachmentError(MESSAGES.quota)
      throw new AttachmentError(MESSAGES.failed)
    }
  }

  #announce(hash: string, mime: string, file: number | undefined): Promise<string> {
    let resolve!: (path: string) => void
    let reject!: (error: AttachmentError) => void
    const promise = new Promise<string>((res, rej) => {
      resolve = res
      reject = rej
    })
    const timer = setTimeout(
      () => reject(new AttachmentError(MESSAGES.timeout)),
      this.#opts.storedTimeoutMs ?? 30_000,
    )
    const done = () => {
      clearTimeout(timer)
      if (this.#pending.get(hash)?.promise === promise) this.#pending.delete(hash)
    }
    promise.then(done, done)
    this.#pending.set(hash, { mime, file, promise, resolve, reject })
    this.#opts.send({ kind: 'announce', hash, mime }, file)
    return promise
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
