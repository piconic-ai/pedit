import { META_LIMITS, metaUse, randomBase64Url } from '@pedit/protocol'
import * as Y from 'yjs'
import { nodeText, read as readCanvas } from './canvas.ts'
import type { Cell, Table } from './csv.ts'
import { defaultStore, type Store as Prefs } from './storage.ts'
import { type Readable, Store } from './store.ts'
import type { Position } from './table.ts'

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
  /** The corner cells of a thread on a table's cells, while attached or changed. */
  cells: { from: Position; to: Position } | null
  /** The node of a thread on a canvas, while attached or changed. */
  node: string | null
}

/** What a new comment goes on: the editor's selection, or cells of the table. */
export type CommentTarget =
  | { kind: 'text'; from: number; to: number }
  | { kind: 'cells'; from: Position; to: Position }
  | { kind: 'node'; id: string }

/** Limits on what a comment holds, as internal/meta/meta.go keeps them. */
export const COMMENT_LIMITS = {
  threads: 500,
  messages: 200,
  body: 4000,
  author: 200,
  quote: 1000,
  /** Past this, by metaDocSize, the editor offers no new comment: well under META_LIMITS.maxDocBytes. */
  docBytes: Math.floor(META_LIMITS.maxDocBytes / 4),
  /** What one change can add, at most, kept free under the hard limit. */
  margin: 16 * 1024,
} as const

const ID = /^[A-Za-z0-9_-]{1,32}$/
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,9})?Z$/
const ANCHORS = new Set(['text', 'cells', 'node'])
/** internal/meta/meta.go's MaxNodeID, in bytes of UTF-8. */
const MAX_NODE_ID = 1024
const utf8 = new TextEncoder()
/** A random thread or comment id: 16 characters of base64url. */
export function newId(): string {
  return randomBase64Url(12)
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
  /** Whether the room takes no changes now: it has ended, or waits for the host. */
  locked?: () => boolean
  /** The file parsed as a table, when it is CSV or TSV, so threads can go on cells. */
  table?: Readable<Table | null>
  /** Whether the file is a canvas, whose threads go on its nodes. */
  canvas?: boolean
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
  readonly #content: Y.Doc
  readonly #text: Y.Text
  readonly #opts: CommentsOptions
  readonly #mine = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | null = null
  #shown = '[]'
  /**
   * What the comments take of the limits every peer holds them to, and
   * whether they changed since it was worked out.
   */
  #use = { bytes: 0, listWork: 0 }
  #measure = true
  readonly #stopTable: () => void
  readonly #metaChanged = () => {
    this.#measure = true
    this.#schedule()
  }
  // The text moves the threads only when there are any.
  readonly #textChanged = () => {
    if (this.#comments.size > 0) this.#schedule()
  }

  constructor(meta: Y.Doc, content: Y.Doc, opts: CommentsOptions) {
    this.#meta = meta
    this.#content = content
    this.#text = content.getText('content')
    this.#opts = opts
    meta.on('update', this.#metaChanged)
    content.on('update', this.#textChanged)
    // A file becomes a table once the editor knows its name.
    this.#stopTable = opts.table?.subscribe(this.#textChanged) ?? (() => {})
    this.refresh()
  }

  destroy(): void {
    this.#meta.off('update', this.#metaChanged)
    this.#text.doc?.off('update', this.#textChanged)
    this.#stopTable()
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
    if (quote.length === 0) return null
    return this.#begin(quote, body, {
      type: 'text',
      start: position(this.#text, from, 0),
      end: position(this.#text, to, -1),
    })
  }

  /**
   * Starts a thread on the cells of a table between two corners, as start
   * does on text. Null as for start, but an empty cell takes one, or when a
   * corner is not a cell of the table now.
   */
  startCells(a: Position, b: Position, body: string): string | null {
    const table = this.#table(this.#text.toString())
    const from = table?.rows[Math.min(a.row, b.row)]?.cells[Math.min(a.col, b.col)]
    const to = table?.rows[Math.max(a.row, b.row)]?.cells[Math.max(a.col, b.col)]
    // The host saves no corner longer than a quote; it would lose the cells.
    const long = (c: Cell) => c.to - c.from > COMMENT_LIMITS.quote
    if (!table || !from || !to || long(from) || long(to)) return null
    // A range's raw text quotes it, cut to the limit, so a long column takes one too.
    return this.#begin(cutQuote(table.text.slice(from.from, to.to)), body, {
      type: 'cells',
      from: this.#cell(from),
      to: this.#cell(to),
    })
  }

  /**
   * Starts a thread on a node of a canvas, as start does on text: it quotes
   * what the node shows, cut to the limit. Null as for start, or when there
   * is no such node.
   */
  startNode(id: string, body: string): string | null {
    const shown = this.#nodes().get(id)
    // The host keeps no thread on an id longer, in UTF-8, than this.
    if (shown === undefined || utf8.encode(id).length > MAX_NODE_ID) return null
    return this.#begin(cutQuote(shown), body, { type: 'node', id })
  }

  /** Starts a thread on a target, as start, startCells or startNode. */
  startOn(target: CommentTarget, body: string): string | null {
    if (target.kind === 'text') return this.start(target.from, target.to, body)
    if (target.kind === 'node') return this.startNode(target.id, body)
    return this.startCells(target.from, target.to, body)
  }

  /** What each node of the canvas shows, by id; none for a file that is no canvas. */
  #nodes(): Map<string, string> {
    if (!this.#opts.canvas) return new Map()
    return new Map(readCanvas(this.#content).nodes.map((n) => [n.id, nodeText(n)]))
  }

  /**
   * A cell's place: it takes in what is typed at its edges, as typing into
   * it does. An empty cell says so: it takes in what is typed after it too.
   */
  #cell(c: Cell): { start: string; end: string; empty?: true } {
    const place = { start: position(this.#text, c.from, -1), end: position(this.#text, c.to, 0) }
    return c.to === c.from ? { ...place, empty: true } : place
  }

  #begin(quote: string, body: string, anchor: Record<string, unknown>): string | null {
    const text = body.trim()
    if (!this.#fits(text) || quote.length > COMMENT_LIMITS.quote) return null
    if (this.#comments.size >= COMMENT_LIMITS.threads) return null
    const id = newId()
    this.#meta.transact(() => {
      const thread = new Y.Map<unknown>()
      this.#comments.set(id, thread)
      thread.set('anchor', anchor)
      thread.set('quote', quote)
      thread.set('resolved', false)
      const messages = new Y.Map<unknown>()
      thread.set('messages', messages)
      this.#add(messages, text)
    })
    this.refresh()
    return id
  }

  /**
   * The table the text is now, or null when it is none, or does not parse:
   * the table view's parse, while it is of this very text.
   */
  #table(text: string): Table | null {
    const table = this.#opts.table?.get() ?? null
    return table?.text === text ? table : null
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
    if (!messages || !this.#mine.has(messageId) || !this.#writable()) return
    this.#meta.transact(() => {
      messages.delete(messageId)
      if (messages.size === 0) this.#comments.delete(threadId)
    })
    this.refresh()
  }

  /** Resolves a thread, or opens it again. Anyone may. */
  resolve(threadId: string, resolved: boolean): void {
    const thread = this.#comments.get(threadId)
    if (!(thread instanceof Y.Map) || !this.#writable()) return
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
    return (
      body.length > 0 &&
      body.length <= COMMENT_LIMITS.body &&
      this.roomForMore.get() &&
      this.#writable()
    )
  }

  /**
   * Whether a change may be made: not while the room takes none, nor near
   * the limit every peer holds the comments to, where they would refuse it
   * and this browser would drift from them. A deletion or change counts
   * there too.
   */
  #writable(): boolean {
    if (this.#opts.locked?.()) return false
    if (this.#measure) this.#measureNow()
    const { bytes, listWork } = this.#use
    // A change adds an item to one list at most, of no more than the square
    // root of the work, and starts a few lists of one.
    const added = 2 * Math.sqrt(listWork) + 16
    return (
      bytes + COMMENT_LIMITS.margin < META_LIMITS.maxDocBytes &&
      listWork + added <= META_LIMITS.maxListWork
    )
  }

  #measureNow(): void {
    this.#measure = false
    this.#use = metaUse(this.#meta)
    this.roomForMore.set(this.#use.bytes < COMMENT_LIMITS.docBytes)
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
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    let index: TextIndex | null = null
    let cells: Cells | null | undefined
    let nodes: Map<string, string> | undefined
    const here: Here = {
      text: this.#text.toString(),
      nodes: () => {
        nodes ??= this.#nodes()
        return nodes
      },
      index: () => {
        index ??= new TextIndex(this.#text)
        return index
      },
      cells: () => {
        if (cells === undefined) {
          const t = this.#table(here.text)
          cells = t && cellsOf(t)
        }
        return cells
      },
    }
    const shown: ShownThread[] = []
    for (const [id, thread] of threadsOf(this.#comments)) {
      const s = this.#show(id, thread, here)
      if (s) shown.push(s)
    }
    shown.sort(order)
    const key = JSON.stringify(shown)
    if (key !== this.#shown) {
      this.#shown = key
      this.threads.set(shown)
    }
    if (this.#measure) this.#measureNow()
  }

  #show(id: string, thread: Y.Map<unknown>, here: Here): ShownThread | null {
    const quote = thread.get('quote')
    if (!isThread(thread) || typeof quote !== 'string') return null
    const anchor = thread.get('anchor')
    const place = placeOf(anchor, here)
    const { live, gone } = liveOf(place, here)
    const state: ThreadState = gone ? 'detached' : live === quote ? 'attached' : 'changed'
    return {
      id,
      state,
      quote: clean(quote, true),
      live: state === 'changed' ? clean(live, true) : '',
      resolved: thread.get('resolved') === true,
      messages: this.#shownMessages(thread.get('messages')),
      from: state === 'detached' ? -1 : (place?.from ?? -1),
      to: state === 'detached' ? -1 : (place?.to ?? -1),
      cells: state === 'detached' ? null : (place?.cells ?? null),
      node: state === 'detached' ? null : (place?.node?.id ?? null),
    }
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

/** The threads of a metadata doc, by id, as far as the limit on them goes. */
function* threadsOf(comments: Y.Map<unknown>): Generator<[string, Y.Map<unknown>]> {
  let count = 0
  for (const id of [...comments.keys()].sort()) {
    const thread = comments.get(id)
    if (!ID.test(id) || !(thread instanceof Y.Map)) continue
    if (++count > COMMENT_LIMITS.threads) return
    yield [id, thread]
  }
}

/** Whether a thread is one to show: a quote within the limit, and an anchor of a kind the host saves. */
function isThread(thread: Y.Map<unknown>): boolean {
  const quote = thread.get('quote')
  return (
    typeof quote === 'string' &&
    quote.length <= COMMENT_LIMITS.quote &&
    ANCHORS.has(kindOf(thread.get('anchor')))
  )
}

/** How many threads of a metadata doc are open, as the panel would list them. */
export function openThreads(meta: Y.Doc): number {
  let open = 0
  for (const [, thread] of threadsOf(meta.getMap('comments'))) {
    if (isThread(thread) && thread.get('resolved') !== true) open++
  }
  return open
}

/**
 * Calls `onCount` with the number of open threads of a metadata doc now,
 * and again each time it changes. Needs only the comments, not the file, so
 * it can follow files nobody has opened. Returns a function that stops.
 */
export function followOpenThreads(meta: Y.Doc, onCount: (open: number) => void): () => void {
  const comments = meta.getMap('comments')
  let last = -1
  const count = () => {
    const open = openThreads(meta)
    if (open === last) return
    last = open
    onCount(open)
  }
  // Only threads coming or going, or a thread's own fields, change the count:
  // not a reply, nor an edit of one.
  const changed = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    if (events.some((e) => e.target === comments || e.target.parent === comments)) count()
  }
  comments.observeDeep(changed)
  count()
  return () => comments.unobserveDeep(changed)
}

/**
 * The open threads of each file of the room, by file id, kept live from the
 * comments docs of the files the room lists, opened or not.
 */
export class OpenCounts {
  readonly counts = new Store<ReadonlyMap<number, number>>(new Map())
  readonly #docOf: (metaId: number) => Y.Doc
  /** What each comments doc followed counts, by its id. */
  readonly #followed = new Map<number, { file: number; stop: () => void }>()

  /** `docOf` gives the comments doc of an id, joining it the first time. */
  constructor(docOf: (metaId: number) => Y.Doc) {
    this.#docOf = docOf
  }

  /** Counts the files listed now, each by the id of its comments doc, and no others. */
  follow(metaOf: ReadonlyMap<number, number>): void {
    const fileOf = new Map([...metaOf].map(([file, meta]) => [meta, file]))
    for (const [meta, f] of this.#followed) {
      if (fileOf.get(meta) === f.file) continue
      f.stop()
      this.#followed.delete(meta)
      this.#set(f.file, 0)
    }
    for (const [meta, file] of fileOf) {
      if (this.#followed.has(meta)) continue
      const stop = followOpenThreads(this.#docOf(meta), (open) => this.#set(file, open))
      this.#followed.set(meta, { file, stop })
    }
  }

  #set(file: number, open: number): void {
    const now = this.counts.get()
    if ((now.get(file) ?? 0) === open) return
    const next = new Map(now)
    if (open > 0) next.set(file, open)
    else next.delete(file)
    this.counts.set(next)
  }
}

/**
 * Whether a key press is the shortcut to comment: Ctrl (⌘ on a Mac) with Alt
 * and M, as document editors have it. AltGr, which some keyboards send as
 * Ctrl with Alt, types a character instead.
 */
export function isCommentKey(e: KeyboardEvent, mac: boolean): boolean {
  const m = e.code === 'KeyM' || e.key.toLowerCase() === 'm'
  const mod = mac ? e.metaKey : e.ctrlKey
  return m && mod && e.altKey && !e.getModifierState('AltGraph')
}

function isMessage(v: unknown): v is Message {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return (
    typeof m.author === 'string' &&
    typeof m.body === 'string' &&
    typeof m.time === 'string' &&
    TIME.test(m.time) &&
    // A real time, as the host parses it: no 13th month.
    !Number.isNaN(Date.parse(m.time)) &&
    new Date(m.time).toISOString().slice(0, 19) === m.time.slice(0, 19)
  )
}

/** A position on the text, base64, as the doc holds it. */
function position(text: Y.Text, index: number, assoc: number): string {
  const bytes = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc))
  return btoa(String.fromCharCode(...bytes))
}

/** The text on screen, looked at once a refresh, and what is costly worked out once. */
interface Here {
  text: string
  nodes: () => Map<string, string>
  index: () => TextIndex
  cells: () => Cells | null
}

/**
 * Every cell of a table in the order of the text, and for each the first
 * cell from it on that is not empty, so a place that took in a run of
 * delimiters is followed past it at once.
 */
interface Cells {
  table: Table
  all: Array<{ cell: Cell; at: Position }>
  full: number[]
}

/** Each table's cells, worked out once: the table view parses each text once. */
const cellsCache = new WeakMap<Table, Cells>()

function cellsOf(table: Table): Cells {
  const known = cellsCache.get(table)
  if (known) return known
  const all = table.rows.flatMap((r, row) =>
    r.cells.map((cell, col) => ({ cell, at: { row, col } })),
  )
  const full = new Array<number>(all.length)
  for (let i = all.length - 1; i >= 0; i--) {
    const { cell } = all[i]!
    full[i] = cell.to > cell.from || i === all.length - 1 ? i : full[i + 1]!
  }
  const cells = { table, all, full }
  cellsCache.set(table, cells)
  return cells
}

interface Place {
  from: number
  to: number
  cells: { from: Position; to: Position } | null
  /** A node's id, and what it shows now. */
  node: { id: string; shows: string } | null
}

/** Where an anchor is now, or null. */
function placeOf(anchor: unknown, here: Here): Place | null {
  if (typeof anchor !== 'object' || anchor === null) return null
  const a = anchor as Record<string, unknown>
  if (a.type === 'cells') {
    const from = cellOf(a.from, here)
    const to = from && cellOf(a.to, here)
    if (!from || !to) return null
    return { from: from.cell.from, to: to.cell.to, cells: { from: from.at, to: to.at }, node: null }
  }
  if (a.type === 'node') {
    const shows = typeof a.id === 'string' ? here.nodes().get(a.id) : undefined
    if (shows === undefined) return null
    return { from: -1, to: -1, cells: null, node: { id: a.id as string, shows } }
  }
  if (a.type !== 'text') return null
  const from = here.index().resolve(a.start)
  const to = from === null ? null : here.index().resolve(a.end)
  return from === null || to === null ? null : { from, to, cells: null, node: null }
}

/**
 * Text cut to a quote's limit, not inside a surrogate pair: half of one
 * reaches the others as U+FFFD, and the quote would never match again.
 */
export function cutQuote(text: string): string {
  const max = COMMENT_LIMITS.quote
  if (text.length <= max) return text
  const high = text.charCodeAt(max - 1)
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max)
}

/** Whether a character ends a cell: a delimiter, or a line break. */
function ends(c: string | undefined, delimiter: string): boolean {
  return c === delimiter || c === '\n' || c === '\r'
}

/**
 * The cell a cell's place holds now. A place takes in what is typed at its
 * edges, so a row or column inserted beside its cell comes into it too:
 * the cell is the one that starts where the place does, past the
 * delimiters and line breaks it took in, and ends at a cell's edge inside
 * it. A deleted cell takes a delimiter with it, and leaves its place on an
 * empty span between its neighbours, where no cell starts and ends: its
 * thread is detached. An empty cell whose column was deleted can pass to an
 * empty neighbour: nothing in the text tells them apart.
 */
function cellOf(v: unknown, here: Here): { cell: Cell; at: Position } | null {
  if (typeof v !== 'object' || v === null) return null
  const p = v as Record<string, unknown>
  // A corner that was an empty cell says so (internal/meta/doc.go too).
  const empty = p.empty === true
  const start = here.index().resolve(p.start)
  const end = start === null ? null : here.index().resolve(p.end)
  const cells = here.cells()
  if (start === null || end === null || !cells) return null
  const { all, table } = cells
  // Found by halves, not by walking what the place took in: between cells
  // there are only delimiters and line breaks, so a start in no cell's text
  // is before the next cell, and empty cells after it are delimiters too.
  let i = firstFrom(all, start, (c) => c.cell.from)
  if (i > 0 && all[i - 1]!.cell.to > start) return null
  i = pastEmpty(cells, i, end, empty)
  const found = all[i]
  if (i < 0 || !found) return null
  const { cell } = found
  if (cell.to > end || (cell.to < end && !ends(table.text[cell.to], table.delimiter))) return null
  return found
}

/**
 * What a place holds now, as its thread quotes it: cells and nodes their
 * text cut to the limit, as they are started. Only a cell or a node may be
 * empty; a place that is not there is gone.
 */
function liveOf(place: Place | null, here: Here): { live: string; gone: boolean } {
  if (!place) return { live: '', gone: true }
  if (place.node) return { live: cutQuote(place.node.shows), gone: false }
  const text = here.text.slice(place.from, place.to)
  if (place.cells) return { live: cutQuote(text), gone: false }
  return { live: text, gone: place.from >= place.to }
}

/** An anchor's kind, or '' when it has none that is a string. */
function kindOf(anchor: unknown): string {
  const type =
    typeof anchor === 'object' && anchor !== null ? (anchor as { type?: unknown }).type : null
  return typeof type === 'string' ? type : ''
}

/**
 * Where the cell a place holds starts, from the first cell at its start, i,
 * or -1. A cell that was empty took in what was typed after it, or a row or
 * column before it: it is the empty cell at the start when something came
 * in, else the one at the end. Any other is the first with text.
 */
function pastEmpty({ all, full }: Cells, i: number, end: number, empty: boolean): number {
  const first = all[i]?.cell
  if (!first || first.to !== first.from || first.from >= end) return i
  const next = all[full[i]!]!.cell
  const content = next.to > next.from && next.from < end
  if (empty && content) return i
  const at = content ? next.from : end
  const j = firstFrom(all, at, (c) => c.cell.from)
  return all[j]?.cell.from === at ? j : -1
}

/** The first of `items`, sorted by `key`, whose key is at least `at`; their length for none. */
function firstFrom<T>(items: readonly T[], at: number, key: (item: T) => number): number {
  let lo = 0
  let hi = items.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (key(items[mid]!) < at) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Where each item of the text starts, worked out once a refresh: resolving
 * an anchor is then a lookup, where Yjs walks the text back from each one,
 * and a peer's threads could make every keystroke cost that many walks.
 */
export class TextIndex {
  readonly #items = new Map<number, Array<{ item: Y.Item; at: number }>>()
  readonly #length: number

  constructor(text: Y.Text) {
    let at = 0
    for (let n = text._start; n !== null; n = n.right) {
      const list = this.#items.get(n.id.client) ?? []
      list.push({ item: n, at })
      this.#items.set(n.id.client, list)
      if (!n.deleted && n.countable) at += n.length
    }
    for (const list of this.#items.values()) list.sort((a, b) => a.item.id.clock - b.item.id.clock)
    this.#length = at
  }

  /**
   * Where a position of the doc, base64, is now, as every peer resolves it:
   * as Y.createAbsolutePositionFromRelativePosition does with
   * followUndoneDeletions off, so an undo does not move it on one peer
   * only. One at an end of the text names it, 'content'; a position of any
   * other type is none, where Yjs would make a root type of a name a peer
   * chose.
   */
  resolve(v: unknown): number | null {
    if (typeof v !== 'string' || v.length > 256) return null
    let rel: Y.RelativePosition
    try {
      rel = Y.decodeRelativePosition(Uint8Array.from(atob(v), (c) => c.charCodeAt(0)))
    } catch {
      return null
    }
    const id = rel.item
    if (id === null) return rel.tname === 'content' ? (rel.assoc >= 0 ? this.#length : 0) : null
    const list = this.#items.get(id.client) ?? []
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const { item } = list[mid]!
      if (item.id.clock + item.length > id.clock) hi = mid
      else lo = mid + 1
    }
    const found = list[lo]
    if (!found || found.item.id.clock > id.clock) return null
    const { item, at } = found
    if (item.deleted || !item.countable) return at
    return at + id.clock - item.id.clock + (rel.assoc >= 0 ? 0 : 1)
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

export const COMMENTS_OPEN_KEY = 'pedit:comments'

/** Whether this browser left the comments panel open, or null if it never chose. */
export function loadCommentsOpen(store: Prefs | null = defaultStore()): boolean | null {
  try {
    const v = store?.getItem(COMMENTS_OPEN_KEY)
    return v === 'open' ? true : v === 'closed' ? false : null
  } catch {
    return null
  }
}

export function saveCommentsOpen(open: boolean, store: Prefs | null = defaultStore()): void {
  try {
    store?.setItem(COMMENTS_OPEN_KEY, open ? 'open' : 'closed')
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
}

/** Which threads the comments panel lists: the open ones or the resolved ones. */
export type ThreadList = 'open' | 'resolved'

/**
 * Keeps `list` on the list of the thread in focus, as a mark in the text, a
 * cell or a node puts one in focus. Returns a function that stops.
 */
export function followFocus(
  threads: Readable<readonly ShownThread[]>,
  focus: Readable<string | null>,
  list: Store<ThreadList>,
): () => void {
  return focus.subscribe((id) => {
    const t = threads.get().find((x) => x.id === id)
    if (t) list.set(t.resolved ? 'resolved' : 'open')
  })
}

// Made once: a formatter is costly to make, and the panel formats every comment's time.
const timeOfDay = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })
const dayThisYear = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const day = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** A comment's time, short: the time of day today, the date before. */
export function shortTime(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (d.toDateString() === now.toDateString()) return timeOfDay.format(d)
  return (d.getFullYear() === now.getFullYear() ? dayThisYear : day).format(d)
}

/** A comment's time, in the reader's own time zone, to the minute. */
export function fullTime(iso: string): string {
  return full.format(new Date(iso))
}
