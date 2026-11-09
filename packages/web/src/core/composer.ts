import { type CommentTarget, type Draft, isCommentKey } from './comments.ts'
import type { FileSet } from './files.ts'
import { isMac } from './menu.ts'
import { type Readable, Store } from './store.ts'

/** A point in the viewport, in px: where the end of the selection is. */
export interface Anchor {
  x: number
  y: number
}

/** The part of the screen that can be seen: the visual viewport, which a soft keyboard shrinks. */
export interface Visible {
  width: number
  height: number
  /** Its top edge in the layout viewport, which the page pans it by. */
  top: number
}

/** What a comment composer holds on to from the moment it opens. */
export interface Composing extends Anchor {
  /** What the comment goes on: frozen, so what happens to the selection afterwards does not move it. */
  target: CommentTarget
  /** Its quote and anchor as they were when it opened: the anchor follows the edits that come after. */
  draft: Draft
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
  /** The visible part of the screen, for the composer to stay in. */
  readonly visible = new Store<{ top: number; height: number }>({ top: 0, height: 0 })

  readonly #files: FileSet
  readonly #locked: Readable<boolean>
  readonly #show: () => void
  readonly #viewport: () => Visible
  readonly #stops: (() => void)[] = []
  /** Whether the target last asked about can take a thread. */
  #draftable: { target: CommentTarget; ok: boolean } | null = null
  #stopRoom = () => {}

  /**
   * `locked` is whether the room takes no new comments; `show` makes a
   * thread visible once one is sent (opens the panel).
   */
  constructor(
    files: FileSet,
    locked: Readable<boolean>,
    show: () => void,
    viewport: () => Visible,
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
      files.mode.subscribe(() => this.cancel()),
      files.shown.subscribe(() => {
        this.cancel()
        this.place()
      }),
      files.comments.subscribe(() => {
        this.#draftable = null
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
    const vp = this.#viewport()
    const v = this.visible.get()
    if (v.top !== vp.top || v.height !== vp.height)
      this.visible.set({ top: vp.top, height: vp.height })
    const target = this.#files.target.get()
    if (!this.composing.get() && target && this.#canWrite() && this.#canDraft(target)) {
      const p = this.#files.targetPlace()
      // Not when it is scrolled out of sight, in the view or in the page.
      const inside = (r: { left: number; right: number; top: number; bottom: number }) =>
        !!p && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
      if (
        p &&
        inside(p.clip) &&
        inside({ left: 0, right: vp.width, top: vp.top, bottom: vp.top + vp.height })
      ) {
        next = { x: p.x, y: p.y }
      }
    }
    if (!same(next, this.button.get())) this.button.set(next)
  }

  /** Whether the comments can make a thread on the target; asked again only for a new target. */
  #canDraft(target: CommentTarget): boolean {
    if (this.#draftable?.target !== target) {
      this.#draftable = { target, ok: !!this.#files.comments.get()?.draft(target) }
    }
    return this.#draftable.ok
  }

  /** Opens the composer on the target now; false when there is nothing to comment on. */
  open(): boolean {
    const target = this.#files.target.get()
    const draft = target && this.#files.comments.get()?.draft(target)
    if (!target || !draft || !this.#canWrite()) return false
    const { width, height, top } = this.#viewport()
    const at = this.button.get() ?? { x: width / 2, y: top + height / 3 }
    this.composing.set({ target, draft, x: at.x, y: at.y })
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
    const id = view.startDraft(c.draft, body)
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
