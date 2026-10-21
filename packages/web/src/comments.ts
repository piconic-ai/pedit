import * as Y from 'yjs'
import { Store } from './store.ts'

/**
 * The comments on one file (#121), from the metadata doc the host shares
 * beside it: threads keyed by id, each with an anchor, the text it quoted,
 * a resolved flag and its comments. docs/design/comments.md has the design,
 * and internal/meta/doc.go reads the same doc.
 *
 * Everything in the doc comes from other people's browsers, so it is checked
 * and cleaned before it is shown, and drawn as text only.
 */

/** Where a thread stands against the text now. */
export type ThreadState = 'attached' | 'changed' | 'detached'

export interface ShownMessage {
  id: string
  author: string
  time: string
  body: string
  /** Written in this browser, so it offers to edit or delete it. */
  mine: boolean
}

export interface ShownThread {
  id: string
  state: ThreadState
  quote: string
  /** The text the anchor covers now, when it differs from the quote. */
  live: string
  resolved: boolean
  messages: ShownMessage[]
  /** Where its anchor is in the text, while attached or changed. */
  from: number
  to: number
}

/** Limits on what a comment holds, as internal/meta/meta.go keeps them. */
export const COMMENT_LIMITS = {
  threads: 500,
  messages: 200,
  body: 4000,
  author: 200,
  quote: 1000,
  /** Past this, the editor offers no new comment (the hard cap is 512 KiB). */
  docBytes: 256 * 1024,
} as const

const ID = /^[A-Za-z0-9_-]{1,32}$/
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'

/** A random thread or comment id. */
export function newId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((b) => ID_CHARS[b % ID_CHARS.length]).join('')
}

/**
 * Drops what could move the cursor or reorder the text around it: control
 * characters but line breaks and tabs when `lines` is set, and bidi controls.
 */
export function clean(s: string, lines = false): string {
  const control = lines ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g : /\p{Cc}/gu
  return s.replace(control, '').replace(/\p{Bidi_Control}/gu, '')
}

export interface CommentsOptions {
  /** The name to sign new comments with. */
  name: () => string
  /** The time now; tests set it. */
  now?: () => Date
  /** How long changes settle before the threads are worked out again. */
  delayMs?: number
}

/**
 * Follows the comments of one text file: publishes its threads, each placed
 * on the text, and makes the changes people ask for. Threads are worked out
 * again a moment after the comments or the text change, not on every key.
 */
export class CommentsView {
  /** Open threads first, then resolved; each in the order of its place, then time. */
  readonly threads = new Store<readonly ShownThread[]>([])
  /** Whether the comments can take another thread or comment. */
  readonly roomForMore = new Store(true)

  readonly #meta: Y.Doc
  readonly #text: Y.Text
  readonly #opts: CommentsOptions
  readonly #mine = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | null = null
  readonly #changed = () => this.#schedule()

  constructor(meta: Y.Doc, content: Y.Doc, opts: CommentsOptions) {
    this.#meta = meta
    this.#text = content.getText('content')
    this.#opts = opts
    meta.on('update', this.#changed)
    content.on('update', this.#changed)
    this.refresh()
  }

  destroy(): void {
    this.#meta.off('update', this.#changed)
    this.#text.doc?.off('update', this.#changed)
    if (this.#timer !== null) clearTimeout(this.#timer)
  }

  get #comments(): Y.Map<unknown> {
    return this.#meta.getMap('comments')
  }

  /**
   * Starts a thread on [from, to) of the text, with its first comment.
   * Returns its id, or null when it cannot be made: an empty range or body,
   * a quote or body over the limits, or no room for more.
   */
  start(from: number, to: number, body: string): string | null {
    const quote = this.#text.toString().slice(from, to)
    const text = body.trim()
    if (!this.#fits(text) || quote.length === 0 || quote.length > COMMENT_LIMITS.quote) return null
    if (this.#comments.size >= COMMENT_LIMITS.threads) return null
    const id = newId()
    this.#meta.transact(() => {
      const thread = new Y.Map<unknown>()
      this.#comments.set(id, thread)
      thread.set('anchor', {
        type: 'text',
        start: position(this.#text, from, 0),
        end: position(this.#text, to, -1),
      })
      thread.set('quote', quote)
      thread.set('resolved', false)
      const messages = new Y.Map<unknown>()
      thread.set('messages', messages)
      this.#add(messages, text)
    })
    this.refresh()
    return id
  }

  /** Adds a comment to a thread. */
  reply(threadId: string, body: string): boolean {
    const messages = this.#messages(threadId)
    const text = body.trim()
    if (!messages || !this.#fits(text) || messages.size >= COMMENT_LIMITS.messages) return false
    this.#add(messages, text)
    this.refresh()
    return true
  }

  /** Changes the text of a comment written in this browser. */
  edit(threadId: string, messageId: string, body: string): boolean {
    const messages = this.#messages(threadId)
    const old = messages?.get(messageId)
    const text = body.trim()
    if (!messages || !this.#mine.has(messageId) || !isMessage(old) || !this.#fits(text))
      return false
    messages.set(messageId, { ...old, body: text })
    this.refresh()
    return true
  }

  /** Deletes a comment written in this browser; the thread with it, if it was the last. */
  remove(threadId: string, messageId: string): void {
    const messages = this.#messages(threadId)
    if (!messages || !this.#mine.has(messageId)) return
    this.#meta.transact(() => {
      messages.delete(messageId)
      if (messages.size === 0) this.#comments.delete(threadId)
    })
    this.refresh()
  }

  /** Resolves a thread, or opens it again. Anyone may. */
  resolve(threadId: string, resolved: boolean): void {
    const thread = this.#comments.get(threadId)
    if (!(thread instanceof Y.Map)) return
    thread.set('resolved', resolved)
    this.refresh()
  }

  #messages(threadId: string): Y.Map<unknown> | null {
    const thread = this.#comments.get(threadId)
    const messages = thread instanceof Y.Map ? thread.get('messages') : null
    return messages instanceof Y.Map ? messages : null
  }

  #add(messages: Y.Map<unknown>, body: string): void {
    const id = newId()
    this.#mine.add(id)
    const now = (this.#opts.now ?? (() => new Date()))()
    const author = clean(this.#opts.name()).slice(0, COMMENT_LIMITS.author)
    messages.set(id, { author, time: now.toISOString(), body })
  }

  #fits(body: string): boolean {
    return body.length > 0 && body.length <= COMMENT_LIMITS.body && this.roomForMore.get()
  }

  #schedule(): void {
    if (this.#timer !== null) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.refresh()
    }, this.#opts.delayMs ?? 100)
  }

  /** Works the threads out again now. */
  refresh(): void {
    const text = this.#text.toString()
    const shown: ShownThread[] = []
    let count = 0
    for (const id of [...this.#comments.keys()].sort()) {
      const thread = this.#comments.get(id)
      if (!ID.test(id) || !(thread instanceof Y.Map)) continue
      if (++count > COMMENT_LIMITS.threads) break
      const s = this.#show(id, thread, text)
      if (s) shown.push(s)
    }
    shown.sort(order)
    if (!sameThreads(shown, this.threads.get())) this.threads.set(shown)
    this.roomForMore.set(Y.encodeStateAsUpdate(this.#meta).length < COMMENT_LIMITS.docBytes)
  }

  #show(id: string, thread: Y.Map<unknown>, text: string): ShownThread | null {
    const quote = thread.get('quote')
    if (typeof quote !== 'string' || quote.length > COMMENT_LIMITS.quote) return null
    const place = this.#place(thread.get('anchor'))
    const live = place ? text.slice(place.from, place.to) : ''
    const state: ThreadState =
      !place || place.from >= place.to ? 'detached' : live === quote ? 'attached' : 'changed'
    return {
      id,
      state,
      quote: clean(quote, true),
      live: state === 'changed' ? clean(live, true) : '',
      resolved: thread.get('resolved') === true,
      messages: this.#shownMessages(thread.get('messages')),
      from: state === 'detached' ? -1 : (place?.from ?? -1),
      to: state === 'detached' ? -1 : (place?.to ?? -1),
    }
  }

  #place(anchor: unknown): { from: number; to: number } | null {
    if (typeof anchor !== 'object' || anchor === null) return null
    const a = anchor as Record<string, unknown>
    if (a.type !== 'text') return null
    const doc = this.#text.doc
    if (!doc) return null
    const from = resolve(a.start, doc)
    const to = resolve(a.end, doc)
    return from === null || to === null ? null : { from, to }
  }

  #shownMessages(messages: unknown): ShownMessage[] {
    if (!(messages instanceof Y.Map)) return []
    const out: ShownMessage[] = []
    for (const id of [...messages.keys()].sort()) {
      const m = messages.get(id)
      if (!ID.test(id) || !isMessage(m) || out.length === COMMENT_LIMITS.messages) continue
      if (m.body.length > COMMENT_LIMITS.body || m.author.length > COMMENT_LIMITS.author) continue
      out.push({
        id,
        author: clean(m.author) || 'anonymous',
        time: m.time,
        body: clean(m.body, true),
        mine: this.#mine.has(id),
      })
    }
    return out.sort((a, b) =>
      a.time === b.time ? (a.id < b.id ? -1 : 1) : a.time < b.time ? -1 : 1,
    )
  }
}

interface Message {
  author: string
  time: string
  body: string
}

function isMessage(v: unknown): v is Message {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return (
    typeof m.author === 'string' &&
    typeof m.body === 'string' &&
    typeof m.time === 'string' &&
    TIME.test(m.time)
  )
}

/** A position on the text, base64, as the doc holds it. */
function position(text: Y.Text, index: number, assoc: number): string {
  const bytes = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc))
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Where a position of the doc is now, as every peer resolves it: with
 * followUndoneDeletions off, so an undo does not move it on one peer only.
 */
function resolve(v: unknown, doc: Y.Doc): number | null {
  if (typeof v !== 'string' || v.length > 256) return null
  try {
    const bytes = Uint8Array.from(atob(v), (c) => c.charCodeAt(0))
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(bytes),
      doc,
      false,
    )
    return abs && abs.type === doc.getText('content') ? abs.index : null
  } catch {
    return null
  }
}

function order(a: ShownThread, b: ShownThread): number {
  if (a.resolved !== b.resolved) return a.resolved ? 1 : -1
  const pa = a.from < 0 ? Number.MAX_SAFE_INTEGER : a.from
  const pb = b.from < 0 ? Number.MAX_SAFE_INTEGER : b.from
  if (pa !== pb) return pa - pb
  const ta = a.messages[0]?.time ?? ''
  const tb = b.messages[0]?.time ?? ''
  return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : 1
}

function sameThreads(a: readonly ShownThread[], b: readonly ShownThread[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
