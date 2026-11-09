'use client'

import { COMMENT_LIMITS } from '../comments.ts'
import { type Anchor, addCommentTitle, type Composing, promptFor } from '../composer.ts'
import type { Readable } from '../store.ts'

export interface CommentComposerProps {
  /** Where the add button is; null for none. */
  button: Readable<Anchor | null>
  /** The composer open now, or null. */
  composing: Readable<Composing | null>
  /** The add button was pressed. */
  onOpen: () => void
  /** Sends the text; true once it is sent. */
  onSend: (body: string) => boolean
  onCancel: () => void
}

/** The comment icon on a 24 by 24 grid: a speech bubble with a plus. */
const BUBBLE = 'M4 5h16v11H9l-5 4zM12 8v5M9.5 10.5h5'

/**
 * Comments in place: a small button by the selection, and the composer it
 * opens at the same spot. Positions are in the viewport, so both are fixed.
 */
export function CommentComposer(props: CommentComposerProps) {
  return (
    <div className="comment-float">
      <button
        type="button"
        className="comment-add"
        title={addCommentTitle()}
        aria-label={addCommentTitle()}
        hidden={props.button.get() === null}
        style={`left: min(${(props.button.get()?.x ?? 0) + 4}px, calc(100vw - 40px)); top: min(${(props.button.get()?.y ?? 0) + 4}px, calc(100vh - 40px))`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.onOpen()}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d={BUBBLE} />
        </svg>
      </button>
      {props.composing.get() ? (
        <ComposerBox
          x={props.composing.get()?.x ?? 0}
          y={props.composing.get()?.y ?? 0}
          placeholder={promptFor(props.composing.get()?.target as NonNullable<Composing['target']>)}
          onSend={props.onSend}
          onCancel={props.onCancel}
        />
      ) : null}
    </div>
  )
}

interface ComposerBoxProps {
  x: number
  y: number
  placeholder: string
  onSend: (body: string) => boolean
  onCancel: () => void
}

/** The box at the selection. Ctrl or ⌘ with Enter sends; Escape cancels. */
function ComposerBox(props: ComposerBoxProps) {
  let box: HTMLTextAreaElement | undefined
  const send = () => {
    if (box) props.onSend(box.value)
  }
  return (
    <div
      className="comment-compose"
      role="group"
      aria-label="New comment"
      style={`left: min(${props.x + 4}px, calc(100vw - 296px)); top: min(${props.y + 4}px, calc(100vh - 150px))`}
    >
      <textarea
        ref={(el) => {
          box = el
          // Once it is in the page, so it can take the focus.
          queueMicrotask(() => el.focus())
        }}
        rows={3}
        maxlength={COMMENT_LIMITS.body}
        placeholder={props.placeholder}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            send()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            props.onCancel()
          }
        }}
      />
      <div className="comment-buttons">
        <button type="button" className="comment-text-button" onClick={() => props.onCancel()}>
          Cancel
        </button>
        <button type="button" className="comment-primary" onClick={send}>
          Comment
        </button>
      </div>
    </div>
  )
}
