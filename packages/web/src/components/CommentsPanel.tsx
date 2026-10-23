'use client'

import { createMemo, createSignal } from '@barefootjs/client'
import {
  COMMENT_LIMITS,
  type CommentsView,
  type CommentTarget,
  fullTime,
  type ShownMessage,
  type ShownThread,
  shortTime,
  type ThreadList,
} from '../comments.ts'
import { initials } from '../identity.ts'
import type { ContextMenu } from '../menu.ts'
import { colorOf } from '../room.ts'
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
  /** The list on screen; followFocus keeps it on the thread in focus. */
  list: Store<ThreadList>
  /** Shows a thread's place in the editor. */
  onShow: (thread: ShownThread) => void
  /** The colour each name in the room has in the header, for the authors here now. */
  colors: Readable<ReadonlyMap<string, string>>
  /** The menu of one's own comments: edit or delete. */
  menu: ContextMenu
  /** Whether the panel is open: unfolded on a narrow screen, shown on a wide one. */
  open: Readable<boolean>
  /** The title was pressed: on a narrow screen, it folds or unfolds the panel. */
  onToggle: () => void
}

const STATE_LABEL = { attached: '', changed: 'Changed', detached: 'Text gone' } as const

/** Icon paths, on a 24 by 24 grid: resolve, reopen, and the menu's three dots. */
const CHECK = 'M5 12.5l4.5 4.5L19 7.5'
const REOPEN = 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4.5h4.5'
const MORE = 'M12 5.5v.01M12 12v.01M12 18.5v.01'

/** One of this browser's comments shown as an edit box, or asking whether to delete it. */
type Action = { message: string; kind: 'edit' | 'delete' }

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
  const tab = () => props.list.get()
  const listed = createMemo(() => threads().filter((t) => t.resolved === (tab() === 'resolved')))
  const counts = createMemo(() => {
    const open = threads().filter((t) => !t.resolved).length
    return { open, resolved: threads().length - open }
  })
  const canWrite = () => !props.locked.get() && (view()?.roomForMore.get() ?? false)
  const canChange = () => !props.locked.get()
  const colorOfAuthor = (name: string) => props.colors.get().get(name) ?? colorOf(name)
  const prompt = () => {
    const t = props.target.get()
    if (!t) return ''
    if (t.kind === 'text') return 'Comment on the selection'
    if (t.kind === 'node') return 'Comment on the node'
    const one = t.from.row === t.to.row && t.from.col === t.to.col
    return one ? 'Comment on the cell' : 'Comment on the cells'
  }
  // The new comment's box grows once the reader starts on it.
  const [composing, setComposing] = createSignal(false)
  const [action, setAction] = createSignal<Action | null>(null)
  const acting = (m: ShownMessage, kind: Action['kind']) => {
    const a = action()
    return a !== null && a.message === m.id && a.kind === kind
  }
  let draft: HTMLTextAreaElement | undefined

  const pick = (list: ThreadList) => {
    props.list.set(list)
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
  const openMenu = (e: MouseEvent, m: ShownMessage) => {
    const at = (e.currentTarget as HTMLElement).getBoundingClientRect()
    props.menu.show(
      [
        // An edit takes room, like a new comment.
        {
          label: 'Edit',
          disabled: !canWrite(),
          action: () => setAction({ message: m.id, kind: 'edit' }),
        },
        { label: 'Delete', action: () => setAction({ message: m.id, kind: 'delete' }) },
      ],
      at.right,
      at.bottom,
    )
  }

  return (
    <aside
      className="comments"
      aria-label="Comments"
      hidden={view() === null}
      data-open={props.open.get() ? 'true' : undefined}
    >
      <span className="menu-host" ref={(el) => el.replaceChildren(props.menu.element)} />
      <h2 className="comments-title">
        <button
          type="button"
          className="comments-toggle"
          aria-expanded={props.open.get() ? 'true' : 'false'}
          onClick={() => props.onToggle()}
        >
          Comments{' '}
          <span className="comments-count">{counts().open > 0 ? String(counts().open) : ''}</span>
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
          Resolved{counts().resolved > 0 ? ` ${counts().resolved}` : ''}
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
      <p className="comments-full" hidden={!canChange() || (view()?.roomForMore.get() ?? true)}>
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
            aria-current={props.focus.get() === t.id ? 'true' : undefined}
            onClick={() => {
              if (props.focus.get() !== t.id) props.focus.set(t.id)
            }}
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
              {t.messages.map((m, i) => (
                <li key={m.id} className="comment-message">
                  <div className="comment-head">
                    <span
                      className="avatar comment-avatar"
                      style={`--c: ${colorOfAuthor(m.author)}`}
                    >
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
                        onClick={(e) => {
                          // Not a click on the card: the card leaves this list.
                          e.stopPropagation()
                          props.focus.set(null)
                          view()?.resolve(t.id, !t.resolved)
                        }}
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
                      hidden={!m.mine || !canChange()}
                      onClick={(e) => openMenu(e, m)}
                    >
                      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                        <path d={MORE} />
                      </svg>
                    </button>
                  </div>
                  {acting(m, 'edit') ? (
                    <CommentBox
                      className="comment-editing"
                      text={m.body}
                      label="Save"
                      focus={true}
                      onSend={(body: string) => {
                        const saved = view()?.edit(t.id, m.id, body) ?? false
                        if (saved) setAction(null)
                        return saved
                      }}
                      onCancel={() => setAction(null)}
                    />
                  ) : (
                    <p className="comment-body">{m.body}</p>
                  )}
                  {acting(m, 'delete') ? (
                    <div className="comment-confirm" role="alertdialog">
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
                          className="comment-danger"
                          onClick={() => {
                            view()?.remove(t.id, m.id)
                            setAction(null)
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
            <CommentBox
              className="comment-reply"
              hidden={!canWrite() || props.focus.get() !== t.id}
              placeholder="Reply"
              label="Reply"
              onSend={(body: string) => view()?.reply(t.id, body) ?? false}
            />
          </li>
        ))}
      </ol>
    </aside>
  )
}

interface CommentBoxProps {
  className: string
  hidden?: boolean
  /** What it holds at first. */
  text?: string
  placeholder?: string
  /** The send button's label. */
  label: string
  /** Takes the focus once in the page. */
  focus?: boolean
  /** Sends the text; true once it is sent, and the box empties. */
  onSend: (body: string) => boolean
  /** Shows a Cancel button that calls it; without it, Escape just empties the box. */
  onCancel?: () => void
}

/** A box to write a reply or an edit in. Ctrl or ⌘ with Enter sends it. */
function CommentBox(props: CommentBoxProps) {
  let box: HTMLTextAreaElement | undefined
  const send = () => {
    if (box && props.onSend(box.value)) box.value = ''
  }
  const cancel = () => {
    if (props.onCancel) props.onCancel()
    else if (box) box.value = ''
  }
  return (
    <div className={props.className} hidden={props.hidden ?? false}>
      <textarea
        ref={(el) => {
          box = el
          el.value = props.text ?? ''
          // Once it is in the page, so it can take the focus.
          if (props.focus) queueMicrotask(() => el.focus())
        }}
        rows={props.text ? 3 : 1}
        maxlength={COMMENT_LIMITS.body}
        placeholder={props.placeholder ?? ''}
        onKeyDown={(e) => keys(e, send, cancel)}
      />
      <div className="comment-buttons">
        {props.onCancel ? (
          <button type="button" className="comment-text-button" onClick={cancel}>
            Cancel
          </button>
        ) : null}
        <button type="button" className="comment-primary" onClick={send}>
          {props.label}
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
