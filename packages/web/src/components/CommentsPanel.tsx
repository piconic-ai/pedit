'use client'

import type { CommentsView, ShownThread } from '../comments.ts'
import type { Readable, Store } from '../store.ts'

export interface CommentsPanelProps {
  /** The comments of the file on screen, or null when it has none. */
  comments: Readable<CommentsView | null>
  /** The editor's selection: a comment goes on it. */
  selection: Readable<{ from: number; to: number }>
  /** No new comments, replies or changes: the room has ended or waits. */
  locked: Readable<boolean>
  /** The thread in focus, marked in the text too. */
  focus: Store<string | null>
  /** Shows a thread's place in the editor. */
  onShow: (thread: ShownThread) => void
}

const STATE_LABEL = { attached: '', changed: 'Changed', detached: 'Text gone' } as const

/**
 * The comments of the file on screen: a box to comment on the selection,
 * then each thread with its quote and comments. Everything people wrote is
 * shown as text.
 */
export function CommentsPanel(props: CommentsPanelProps) {
  const view = () => props.comments.get()
  const threads = () => view()?.threads.get() ?? []
  const open = () => threads().filter((t) => !t.resolved).length
  const selected = () => {
    const s = props.selection.get()
    return s.to > s.from
  }
  const canWrite = () => !props.locked.get() && (view()?.roomForMore.get() ?? false)
  let draft: HTMLTextAreaElement | undefined

  const start = () => {
    const v = view()
    const s = props.selection.get()
    if (!v || !draft) return
    const id = v.start(s.from, s.to, draft.value)
    if (id) {
      draft.value = ''
      props.focus.set(id)
    }
  }

  return (
    <aside className="comments" aria-label="Comments" hidden={view() === null}>
      <h2 className="comments-title">
        Comments <span className="comments-count">{open() > 0 ? String(open()) : ''}</span>
      </h2>
      <p className="comments-note">Saved on the host's computer, in .pedit/meta/.</p>
      <div className="comments-new" hidden={!canWrite()}>
        <textarea
          ref={(el) => {
            draft = el
          }}
          rows={3}
          maxlength={4000}
          placeholder={selected() ? 'Comment on the selection' : 'Select text to comment on it'}
          disabled={!selected()}
        />
        <button type="button" disabled={!selected()} onClick={start}>
          Comment
        </button>
      </div>
      <p
        className="comments-full"
        hidden={props.locked.get() || (view()?.roomForMore.get() ?? true)}
      >
        This file has as many comments as it can hold.
      </p>
      <ol className="comments-threads">
        {threads().map((t) => (
          <li
            key={t.id}
            className="comment-thread"
            data-state={t.state}
            data-resolved={t.resolved ? 'true' : undefined}
            aria-current={props.focus.get() === t.id ? 'true' : undefined}
          >
            <button
              type="button"
              className="comment-quote"
              title={
                t.state === 'detached' ? 'Its text is no longer in the file' : 'Show in the text'
              }
              onClick={() => {
                props.focus.set(t.id)
                props.onShow(t)
              }}
            >
              <span className="comment-state">{STATE_LABEL[t.state]}</span>
              <q>{t.quote}</q>
              {t.state === 'changed' ? <span className="comment-live">Now: {t.live}</span> : null}
            </button>
            <ol className="comment-messages">
              {t.messages.map((m) => (
                <li key={m.id} className="comment-message">
                  <bdi className="comment-author">{m.author}</bdi>{' '}
                  <time className="comment-time" datetime={m.time}>
                    {m.time.slice(0, 16).replace('T', ' ')}
                  </time>
                  <p className="comment-body">{m.body}</p>
                  <button
                    type="button"
                    className="comment-delete"
                    hidden={!m.mine || props.locked.get()}
                    onClick={() => view()?.remove(t.id, m.id)}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ol>
            <Reply
              hidden={!canWrite()}
              onReply={(body: string) => view()?.reply(t.id, body) ?? false}
            />
            <button
              type="button"
              className="comment-resolve"
              hidden={props.locked.get()}
              onClick={() => view()?.resolve(t.id, !t.resolved)}
            >
              {t.resolved ? 'Reopen' : 'Resolve'}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  )
}

/** A box to answer a thread. */
function Reply(props: { hidden: boolean; onReply: (body: string) => boolean }) {
  let box: HTMLTextAreaElement | undefined
  return (
    <div className="comment-reply" hidden={props.hidden}>
      <textarea
        ref={(el) => {
          box = el
        }}
        rows={1}
        maxlength={4000}
        placeholder="Reply"
      />
      <button
        type="button"
        onClick={() => {
          if (box && props.onReply(box.value)) box.value = ''
        }}
      >
        Reply
      </button>
    </div>
  )
}
