'use client'

import { createSignal } from '@barefootjs/client'
import {
  COMMENT_LIMITS,
  type CommentsView,
  type CommentTarget,
  colorOf,
  type ShownMessage,
  type ShownThread,
  shortTime,
} from '../comments.ts'
import { initials } from '../identity.ts'
import type { Participant } from '../room.ts'
import type { Readable, Store } from '../store.ts'

export interface CommentsPanelProps {
  /** The comments of the file on screen, or null when it has none. */
  comments: Readable<CommentsView | null>
  /** What a new comment goes on: the editor's selection or the table's cells; null for nothing. */
  target: Readable<CommentTarget | null>
  /** No new comments, replies or changes: the room has ended or waits. */
  locked: Readable<boolean>
  /** The thread in focus, marked in the text too. */
  focus: Store<string | null>
  /** Shows a thread's place in the editor. */
  onShow: (thread: ShownThread) => void
  /** Who is in the room, so an author here has the colour they have in the header. */
  people: Readable<readonly Participant[]>
}

const STATE_LABEL = { attached: '', changed: 'Changed', detached: 'Text gone' } as const

/** Icon paths, on a 24 by 24 grid: resolve, reopen, and the menu's three dots. */
const CHECK = 'M5 12.5l4.5 4.5L19 7.5'
const REOPEN = 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4.5h4.5'
const MORE = 'M12 5.5v.01M12 12v.01M12 18.5v.01'

/** What one of this browser's comments is showing instead of its text: a menu, an edit box or a question. */
type Action = { message: string; kind: 'menu' | 'edit' | 'delete' }

/**
 * The comments of the file on screen, as cards in the margin: the open ones,
 * or the resolved ones to look back at. A card shows its quote and comments;
 * the card in focus also takes a reply. A comment of one's own can be edited
 * or deleted from its menu, deleting only once asked again. Everything
 * people wrote is shown as text.
 */
export function CommentsPanel(props: CommentsPanelProps) {
  const view = () => props.comments.get()
  const threads = () => view()?.threads.get() ?? []
  const focused = () => threads().find((t) => t.id === props.focus.get()) ?? null
  // The list the reader picked; a thread in focus shows the list it is in.
  const [picked, setPicked] = createSignal<'open' | 'resolved'>('open')
  const tab = () => {
    const t = focused()
    return t ? (t.resolved ? 'resolved' : 'open') : picked()
  }
  const listed = () => threads().filter((t) => t.resolved === (tab() === 'resolved'))
  const open = () => threads().filter((t) => !t.resolved).length
  const resolved = () => threads().length - open()
  const canWrite = () => !props.locked.get() && (view()?.roomForMore.get() ?? false)
  const canChange = () => !props.locked.get()
  const colorOfAuthor = (name: string) =>
    props.people.get().find((p) => p.name === name)?.color ?? colorOf(name)
  const prompt = () => {
    const t = props.target.get()
    if (!t) return ''
    if (t.kind === 'text') return 'Comment on the selection'
    if (t.kind === 'node') return 'Comment on the node'
    const one = t.from.row === t.to.row && t.from.col === t.to.col
    return one ? 'Comment on the cell' : 'Comment on the cells'
  }
  // On a narrow screen the panel covers the text: it opens on demand.
  const [unfolded, setUnfolded] = createSignal(false)
  // The new comment's box grows once the reader starts on it.
  const [composing, setComposing] = createSignal(false)
  const [action, setAction] = createSignal<Action | null>(null)
  const acting = (m: ShownMessage, kind: Action['kind']) => {
    const a = action()
    return a !== null && a.message === m.id && a.kind === kind
  }
  let draft: HTMLTextAreaElement | undefined

  const pick = (list: 'open' | 'resolved') => {
    setPicked(list)
    setAction(null)
    props.focus.set(null)
  }
  const start = () => {
    const v = view()
    const t = props.target.get()
    if (!v || !draft || !t) return
    const id = v.startOn(t, draft.value)
    if (id) {
      draft.value = ''
      setComposing(false)
      props.focus.set(id)
    }
  }
  const cancel = () => {
    if (draft) draft.value = ''
    setComposing(false)
  }
  const resolve = (t: ShownThread) => {
    view()?.resolve(t.id, !t.resolved)
    // The card leaves this list: nothing stays in focus.
    props.focus.set(null)
  }
  const save = (t: ShownThread, m: ShownMessage, box: HTMLTextAreaElement) => {
    if (view()?.edit(t.id, m.id, box.value)) setAction(null)
  }
  const remove = (t: ShownThread, m: ShownMessage) => {
    view()?.remove(t.id, m.id)
    setAction(null)
  }

  return (
    <aside
      className="comments"
      aria-label="Comments"
      hidden={view() === null}
      data-open={unfolded() ? 'true' : undefined}
    >
      <h2 className="comments-title">
        <button
          type="button"
          className="comments-toggle"
          aria-expanded={unfolded() ? 'true' : 'false'}
          onClick={() => setUnfolded(!unfolded())}
        >
          Comments <span className="comments-count">{open() > 0 ? String(open()) : ''}</span>
        </button>
      </h2>
      <div className="comments-tabs" role="tablist" aria-label="Show">
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'open' ? 'true' : 'false'}
          onClick={() => pick('open')}
        >
          Open
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab() === 'resolved' ? 'true' : 'false'}
          onClick={() => pick('resolved')}
        >
          Resolved{resolved() > 0 ? ` ${resolved()}` : ''}
        </button>
      </div>
      <div
        className="comments-new"
        hidden={!canWrite() || props.target.get() === null || tab() !== 'open'}
        data-composing={composing() ? 'true' : undefined}
      >
        <textarea
          ref={(el) => {
            draft = el
          }}
          rows={composing() ? 3 : 1}
          maxlength={COMMENT_LIMITS.body}
          placeholder={prompt()}
          onFocus={() => setComposing(true)}
          onBlur={() => {
            if (!draft?.value) setComposing(false)
          }}
          onKeyDown={(e) => keys(e, start, cancel)}
        />
        <div className="comment-buttons">
          <button type="button" className="comment-text-button" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="comment-primary" onClick={start}>
            Comment
          </button>
        </div>
      </div>
      <p
        className="comments-full"
        hidden={props.locked.get() || (view()?.roomForMore.get() ?? true)}
      >
        This file has as many comments as it can hold.
      </p>
      <p className="comments-empty" hidden={listed().length > 0}>
        {tab() === 'resolved'
          ? 'No resolved comments.'
          : canWrite()
            ? 'No comments yet. Select something to comment on it.'
            : 'No comments yet.'}
      </p>
      <ol className="comments-threads">
        {listed().map((t) => (
          <li
            key={t.id}
            className="comment-thread"
            data-state={t.state}
            data-resolved={t.resolved ? 'true' : undefined}
            aria-current={props.focus.get() === t.id ? 'true' : undefined}
            onClick={(e) => {
              // Its buttons do their own thing: resolving takes the card out of focus.
              if ((e.target as Element).closest('button')) return
              if (props.focus.get() !== t.id) props.focus.set(t.id)
            }}
          >
            <button
              type="button"
              className="comment-quote"
              title={
                t.state === 'detached' ? 'Its text is no longer in the file' : 'Show in the text'
              }
              onClick={() => props.onShow(t)}
            >
              <span className="comment-state">{STATE_LABEL[t.state]}</span>
              <q>{t.quote}</q>
              {t.state === 'changed' ? <span className="comment-live">Now: {t.live}</span> : null}
            </button>
            <ol className="comment-messages">
              {t.messages.map((m, i) => (
                <li key={m.id} className="comment-message">
                  <div className="comment-head">
                    <span className="comment-avatar" style={`--c: ${colorOfAuthor(m.author)}`}>
                      {initials(m.author)}
                    </span>
                    <span className="comment-who">
                      <bdi className="comment-author">{m.author}</bdi>
                      <time className="comment-time" datetime={m.time} title={fullTime(m.time)}>
                        {shortTime(m.time)}
                      </time>
                    </span>
                    {i === 0 ? (
                      <button
                        type="button"
                        className="comment-icon comment-resolve"
                        title={t.resolved ? 'Reopen' : 'Resolve'}
                        aria-label={t.resolved ? 'Reopen' : 'Resolve'}
                        hidden={!canChange()}
                        onClick={() => resolve(t)}
                      >
                        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                          <path d={t.resolved ? REOPEN : CHECK} />
                        </svg>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="comment-icon comment-more"
                      title="More"
                      aria-label="More"
                      aria-haspopup="menu"
                      aria-expanded={acting(m, 'menu') ? 'true' : 'false'}
                      hidden={!m.mine || !canChange()}
                      onClick={() =>
                        setAction(acting(m, 'menu') ? null : { message: m.id, kind: 'menu' })
                      }
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                        <path d={MORE} />
                      </svg>
                    </button>
                    <div
                      className="comment-menu"
                      role="menu"
                      hidden={!acting(m, 'menu')}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setAction(null)
                      }}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        className="comment-edit"
                        onClick={() => setAction({ message: m.id, kind: 'edit' })}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="comment-delete"
                        onClick={() => setAction({ message: m.id, kind: 'delete' })}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {acting(m, 'edit') ? (
                    <div className="comment-editing">
                      <textarea
                        ref={(el) => {
                          el.value = m.body
                          el.focus()
                        }}
                        rows={3}
                        maxlength={COMMENT_LIMITS.body}
                        onKeyDown={(e) =>
                          keys(
                            e,
                            () => save(t, m, e.currentTarget as HTMLTextAreaElement),
                            () => setAction(null),
                          )
                        }
                      />
                      <div className="comment-buttons">
                        <button
                          type="button"
                          className="comment-text-button"
                          onClick={() => setAction(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="comment-primary comment-save"
                          onClick={(e) => {
                            const box = (e.currentTarget as HTMLElement)
                              .closest('.comment-editing')
                              ?.querySelector('textarea')
                            if (box) save(t, m, box)
                          }}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="comment-body">{m.body}</p>
                  )}
                  <div className="comment-confirm" role="alertdialog" hidden={!acting(m, 'delete')}>
                    <p>
                      {t.messages.length === 1
                        ? 'Delete this comment and its thread?'
                        : 'Delete this comment?'}
                    </p>
                    <div className="comment-buttons">
                      <button
                        type="button"
                        className="comment-text-button"
                        onClick={() => setAction(null)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="comment-danger comment-delete-confirm"
                        onClick={() => remove(t, m)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <Reply
              hidden={!canWrite() || props.focus.get() !== t.id}
              onReply={(body: string) => view()?.reply(t.id, body) ?? false}
            />
          </li>
        ))}
      </ol>
    </aside>
  )
}

/** A box to answer a thread. */
function Reply(props: { hidden: boolean; onReply: (body: string) => boolean }) {
  let box: HTMLTextAreaElement | undefined
  const send = () => {
    if (box && props.onReply(box.value)) box.value = ''
  }
  return (
    <div className="comment-reply" hidden={props.hidden}>
      <textarea
        ref={(el) => {
          box = el
        }}
        rows={1}
        maxlength={COMMENT_LIMITS.body}
        placeholder="Reply"
        onKeyDown={(e) =>
          keys(e, send, () => {
            if (box) box.value = ''
          })
        }
      />
      <div className="comment-buttons">
        <button type="button" className="comment-primary" onClick={send}>
          Reply
        </button>
      </div>
    </div>
  )
}

/** Ctrl or ⌘ with Enter sends what a box holds; Escape lets it go. */
function keys(e: KeyboardEvent, send: () => void, cancel: () => void): void {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    send()
  } else if (e.key === 'Escape') {
    cancel()
  }
}

/** A comment's time, in the reader's own time zone, to the minute. */
function fullTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
