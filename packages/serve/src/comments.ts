import type { CommentMessage, CommentThread } from './types.ts'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid comments page')
  return value as Record<string, unknown>
}

function message(value: unknown): CommentMessage {
  const m = object(value)
  if (
    typeof m.id !== 'string' ||
    typeof m.author !== 'string' ||
    typeof m.time !== 'string' ||
    typeof m.body !== 'string'
  )
    throw new Error('invalid comment message')
  return { id: m.id, author: m.author, time: m.time, body: m.body }
}

function thread(value: unknown): CommentThread {
  const t = object(value)
  const position = (v: unknown) =>
    v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
  if (
    typeof t.id !== 'string' ||
    typeof t.quote !== 'string' ||
    typeof t.resolved !== 'boolean' ||
    !position(t.from) ||
    !position(t.to)
  )
    throw new Error('invalid comment thread')
  return {
    id: t.id,
    quote: t.quote,
    resolved: t.resolved,
    from: typeof t.from === 'number' ? t.from : null,
    to: typeof t.to === 'number' ? t.to : null,
    messages: [],
  }
}

export class CommentsRead {
  readonly threads: CommentThread[] = []
  #seq = 0
  #seen = new Set<string>()
  #current: { thread: CommentThread; total: number } | undefined

  accept(event: Record<string, unknown>): boolean {
    if (
      event.event !== 'comments_page' ||
      event.seq !== this.#seq++ ||
      typeof event.done !== 'boolean' ||
      !Array.isArray(event.parts)
    )
      throw new Error('invalid comments page sequence')
    if (!event.done && event.parts.length === 0) throw new Error('empty comments page')
    for (const value of event.parts) this.#append(value)
    if (event.done && this.#current) throw new Error('incomplete comment thread')
    return event.done
  }

  #append(value: unknown) {
    const part = object(value)
    const next = thread(part.thread)
    const { offset, total } = part
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof total !== 'number' ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      !Array.isArray(part.messages)
    )
      throw new Error('invalid comments page range')
    const messages = part.messages.map(message)
    if (offset + messages.length > total || (messages.length === 0 && total !== 0))
      throw new Error('incomplete comments page')
    if (offset === 0) {
      if (this.#current || this.#seen.has(next.id))
        throw new Error('duplicate or incomplete comment thread')
      this.#seen.add(next.id)
      this.threads.push(next)
      this.#current = { thread: next, total }
    }
    const current = this.#current
    if (
      !current ||
      current.total !== total ||
      current.thread.messages.length !== offset ||
      current.thread.id !== next.id ||
      current.thread.quote !== next.quote ||
      current.thread.resolved !== next.resolved ||
      current.thread.from !== next.from ||
      current.thread.to !== next.to
    )
      throw new Error('inconsistent comment thread')
    current.thread.messages.push(...messages)
    if (current.thread.messages.length === total) this.#current = undefined
  }
}
