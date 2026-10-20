import { json } from '@codemirror/lang-json'
import { Compartment, EditorState, type Extension, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { type CanvasMessage, MAX_CANVAS_EDIT_BYTES } from '@pedit/protocol'
import { basicSetup } from 'codemirror'
import type * as Y from 'yjs'
import { EDGES, NODES, newId, read, toJSON } from './canvas.ts'
import { Store } from './store.ts'

/** What the pane says under the JSON. */
export type JsonStatus =
  | { kind: 'synced' }
  | { kind: 'editing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'too-large' }
  | { kind: 'sending' }
  | { kind: 'rejected'; message: string }
  | { kind: 'closed' }

export interface JsonPaneOptions {
  /** Sends a canvas message to the room (RoomClient.sendCanvas). */
  send: (message: CanvasMessage) => void
  /** Extensions every editor on the page shares, such as the theme's compartment. */
  extensions?: Extension[]
  /** How long typing has to pause before the JSON is checked and sent. */
  delay?: number
}

/** Marks the pane's own writes to its editor, which are not typing. */
const FOLLOW = 'follow'

/**
 * The canvas as JSON text, to edit by hand: a back door for fixes and bulk
 * edits, not a second way to co-edit. The pane follows the document until
 * someone types in it. Then it keeps what the JSON was before the edit
 * (`base`), and whenever the text is valid JSON again, sends `base` and the
 * new text to the host. The host applies the change as it applies an edit
 * to the file (internal/canvas.Apply) and answers: applied, or rejected with
 * why. Invalid JSON never leaves this pane, so nobody else is affected.
 */
export class JsonPane {
  /** The editor's element, for the board to place. */
  readonly element: HTMLElement
  readonly status = new Store<JsonStatus>({ kind: 'synced' })
  #doc: Y.Doc
  #view: EditorView
  #send: (message: CanvasMessage) => void
  #delay: number
  /** The JSON the pane and the document last agreed on. */
  #base: string
  /**
   * The edit sent and not answered yet. One at a time: an edit sent while
   * another is on its way would start from the same `base` and repeat its
   * inserts when both are applied. The next goes once this one is answered.
   */
  #inFlight: { id: string; base: string; next: string } | null = null
  #timer: ReturnType<typeof setTimeout> | null = null
  #readOnly = new Compartment()
  #closed = false

  constructor(doc: Y.Doc, options: JsonPaneOptions) {
    this.#doc = doc
    this.#send = options.send
    this.#delay = options.delay ?? 400
    this.#base = this.#current()
    this.element = document.createElement('div')
    this.element.className = 'canvas-json-editor'
    this.#view = new EditorView({
      parent: this.element,
      state: EditorState.create({
        doc: this.#base,
        extensions: [
          basicSetup,
          json(),
          EditorView.lineWrapping,
          this.#readOnly.of([]),
          ...(options.extensions ?? []),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            if (u.transactions.every((t) => t.annotation(Transaction.userEvent) === FOLLOW)) {
              return
            }
            this.#typed()
          }),
        ],
      }),
    })
    for (const key of [NODES, EDGES]) doc.getArray(key).observeDeep(() => this.#follow())
  }

  get view(): EditorView {
    return this.#view
  }

  /** The document's canvas as the pane shows it. */
  #current(): string {
    return toJSON(read(this.#doc))
  }

  get #text(): string {
    return this.#view.state.doc.toString()
  }

  /** Whether the pane holds nothing the document does not. */
  get clean(): boolean {
    return this.#text === this.#base && !this.#inFlight
  }

  /**
   * Takes in the document's canvas while the pane holds no edit of its own,
   * changing only the part that differs, so the cursor stays where it was.
   */
  #follow(): void {
    if (!this.clean) return
    const next = this.#current()
    this.#base = next
    const text = this.#text
    if (next === text) return
    let start = 0
    while (start < text.length && start < next.length && text[start] === next[start]) start++
    let end = 0
    while (
      end < text.length - start &&
      end < next.length - start &&
      text[text.length - 1 - end] === next[next.length - 1 - end]
    ) {
      end++
    }
    this.#view.dispatch({
      changes: { from: start, to: text.length - end, insert: next.slice(start, next.length - end) },
      // Not the reader's to undo: undoing it would send a revert of others' edits.
      annotations: [Transaction.userEvent.of(FOLLOW), Transaction.addToHistory.of(false)],
    })
    this.status.set({ kind: 'synced' })
  }

  #typed(): void {
    if (this.#closed) return
    if (this.#timer) clearTimeout(this.#timer)
    this.status.set({ kind: 'editing' })
    this.#timer = setTimeout(() => this.check(), this.#delay)
  }

  /** Checks the text and sends it when it is valid JSON that differs from `base`. */
  check(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    if (this.#closed) return
    const text = this.#text
    // Waiting for an answer: checked again once it comes.
    if (this.#inFlight) return
    if (text === this.#base) {
      this.status.set({ kind: 'synced' })
      // Back to what the canvas was: take in what changed meanwhile.
      this.#follow()
      return
    }
    try {
      JSON.parse(text)
    } catch (e) {
      this.status.set({ kind: 'invalid', message: (e as Error).message })
      return
    }
    const bytes = new TextEncoder().encode(this.#base + text).length
    if (bytes > MAX_CANVAS_EDIT_BYTES) {
      this.status.set({ kind: 'too-large' })
      return
    }
    this.#inFlight = { id: newId(), base: this.#base, next: text }
    this.#send({ kind: 'edit', ...this.#inFlight })
    this.status.set({ kind: 'sending' })
  }

  /** The host's answer to an edit this pane sent; others' answers are not for it. */
  handle(message: CanvasMessage): void {
    if (message.kind === 'edit') return
    const sent = this.#inFlight
    if (!sent || sent.id !== message.id) return
    this.#inFlight = null
    if (message.kind === 'applied') {
      this.#base = sent.next
      if (this.#text === sent.next) {
        this.status.set({ kind: 'synced' })
        // What others changed while this was being edited, now that it is in.
        this.#follow()
      } else {
        // Typed on meanwhile: that goes next, from what was just applied.
        this.check()
      }
    } else {
      this.status.set({ kind: 'rejected', message: message.reason })
    }
  }

  /**
   * After the connection came back. A frame sent or answered while it was
   * down may be gone, so the edit waiting for an answer is sent again, as it
   * was and under the same id: the host answers an edit it already applied
   * without applying it twice.
   */
  reconnected(): void {
    if (this.#inFlight) this.#send({ kind: 'edit', ...this.#inFlight })
  }

  /** While the host is away: nobody would apply an edit. */
  set readOnly(on: boolean) {
    if (this.#closed) return
    this.#view.dispatch({
      effects: this.#readOnly.reconfigure(
        on ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      ),
    })
  }

  /** Once the room has closed: nothing can be sent, so nothing can be typed. */
  close(): void {
    this.#closed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#view.dispatch({
      effects: this.#readOnly.reconfigure([
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ]),
    })
    this.status.set({ kind: 'closed' })
  }
}
