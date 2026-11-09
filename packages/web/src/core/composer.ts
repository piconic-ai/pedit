import { type CommentTarget, isCommentKey } from './comments.ts'
import type { FileSet } from './files.ts'
import { isMac } from './menu.ts'
import { type Readable, Store } from './store.ts'

/** A point in the viewport, in px: where the end of the selection is. */
export interface Anchor {
  x: number
  y: number
}

/** What a comment composer holds on to from the moment it opens. */
export interface Composing extends Anchor {
  /** What the comment goes on: frozen, so what happens to the selection afterwards does not move it. */
  target: CommentTarget
}

/** The placeholder of a box that writes a comment on a target. */
export function promptFor(t: CommentTarget): string {
  if (t.kind === 'text') return 'Comment on the selection'
  if (t.kind === 'node') return 'Comment on the node'
  const one = t.from.row === t.to.row && t.from.col === t.to.col
  return one ? 'Comment on the cell' : 'Comment on the cells'
}

/** The title of the button, with the shortcut of this platform. */
export function addCommentTitle(mac = isMac()): string {
  return mac ? 'Add comment (⌘⌥M)' : 'Add comment (Ctrl+Alt+M)'
}

const same = (a: Anchor | null, b: Anchor | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y)

/**
 * Where a new comment is written: a button by the selection, and the composer
 * it opens there. It follows the target, the view's room for more comments and
 * the lock, and publishes the button's place and the composer as stores for
 * the component to draw.
 */
export class CommentComposer {
  /** Where the button is shown; null for no button. */
  readonly button = new Store<Anchor | null>(null)
  /** The composer open now, with the target it froze. */
  readonly composing = new Store<Composing | null>(null)

  readonly #files: FileSet
  readonly #locked: Readable<boolean>
  readonly #show: () => void
  readonly #viewport: () => { width: number; height: number }
  readonly #stops: (() => void)[] = []
  #stopRoom = () => {}

  /**
   * `locked` is whether the room takes no new comments; `show` makes a
   * thread visible once one is sent (opens the panel).
   */
  constructor(
    files: FileSet,
    locked: Readable<boolean>,
    show: () => void,
    viewport: () => { width: number; height: number },
  ) {
    this.#viewport = viewport
    this.#files = files
    this.#locked = locked
    this.#show = show
    const follow = () => this.place()
    this.#stops.push(
      files.target.subscribe(follow),
      locked.subscribe(() => {
        this.cancel()
        this.place()
      }),
      files.shown.subscribe(() => {
        this.cancel()
        this.place()
      }),
      files.comments.subscribe(() => {
        this.cancel()
        this.#watchRoom()
        this.place()
      }),
    )
    this.#watchRoom()
    this.place()
  }

  #watchRoom(): void {
    this.#stopRoom()
    this.#stopRoom =
      this.#files.comments.get()?.roomForMore.subscribe(() => this.place()) ?? (() => {})
  }

  #canWrite(): boolean {
    return !this.#locked.get() && (this.#files.comments.get()?.roomForMore.get() ?? false)
  }

  /** Works out where the button goes: when the target moved, or the page scrolled or resized. */
  place(): void {
    let next: Anchor | null = null
    if (!this.composing.get() && this.#files.target.get() && this.#canWrite()) {
      const r = this.#files.targetRect()
      // Not when the selection is scrolled out of sight.
      if (r && r.bottom >= 0 && r.top <= this.#viewport().height) next = { x: r.right, y: r.bottom }
    }
    if (!same(next, this.button.get())) this.button.set(next)
  }

  /** Opens the composer on the target now; false when there is nothing to comment on. */
  open(): boolean {
    const target = this.#files.target.get()
    if (!target || !this.#canWrite()) return false
    const { width, height } = this.#viewport()
    const at = this.button.get() ?? { x: width / 2, y: height / 3 }
    this.composing.set({ target, x: at.x, y: at.y })
    this.place()
    return true
  }

  cancel(): void {
    if (!this.composing.get()) return
    this.composing.set(null)
    this.place()
  }

  /** Sends the comment on the frozen target; true once it is sent. */
  send(body: string): boolean {
    const c = this.composing.get()
    const view = this.#files.comments.get()
    if (!c || !view) return false
    const id = view.startOn(c.target, body)
    if (!id) return false
    this.composing.set(null)
    this.#files.list.set('open')
    this.#files.focus.set(id)
    this.#show()
    this.place()
    return true
  }

  /** Whether the key is the shortcut that comments on the selection. */
  isKey(e: KeyboardEvent): boolean {
    return isCommentKey(e, isMac())
  }

  dispose(): void {
    for (const stop of this.#stops) stop()
    this.#stopRoom()
  }
}
