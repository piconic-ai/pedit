'use client'

import { createEffect, createMemo, createSignal } from '@barefootjs/client'
import type { FileEntry, RoomStatus } from '@pedit/protocol'
import { initials } from '../identity.ts'
import type { Participant } from '../room.ts'
import type { SettingsModel } from '../settings.ts'
import type { Readable } from '../store.ts'
import type { ViewSwitch } from '../view.ts'
import { CommentCount } from './FileTabs.tsx'
import { Settings } from './Settings.tsx'

/** How many faces the collapsed row of participants shows before "+N". */
const MAX_FACES = 3

const STATUS_LABELS: Record<RoomStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  waiting: 'Waiting for the host…',
  closed: 'Ended',
  full: 'Room full',
  maintenance: 'Maintenance',
  'client-outdated': 'Outdated',
  'server-outdated': 'Server outdated',
  disconnected: 'Offline',
  busy: 'Busy, retrying…',
  'too-large': 'Too large',
  expired: 'Time limit',
}

export interface HeaderProps {
  /** The host's file name, once the host has told us. */
  file: Readable<string | null>
  status: Readable<RoomStatus>
  people: Readable<readonly Participant[]>
  /** Whether the screen is narrow (NARROW_QUERY). */
  narrow: Readable<boolean>
  view: ViewSwitch
  settings: SettingsModel
  /** How many open comment threads each file has, by id. */
  commentCounts: Readable<ReadonlyMap<number, number>>
  /** The room's files, and the one on screen: the header counts its comments while no tabs show. */
  files: Readable<readonly FileEntry[]>
  current: Readable<number>
  /** Whether the file on screen has comments, so the panel can be shown. */
  commentable: Readable<boolean>
  /** Whether the comments panel is open. */
  commentsOpen: Readable<boolean>
  onToggleComments: () => void
}

/** A speech bubble, on a 24 by 24 grid. */
const BUBBLE = 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'

function label(p: Participant): string {
  return `${p.name}${p.isHost ? ' (host)' : ''}${p.isSelf ? ' (you)' : ''}`
}

/**
 * The top bar: file name, connection status, participants, view buttons and
 * settings. On narrow screens the participants collapse to a row of faces;
 * tapping it shows their names, and the row folds again whenever the screen
 * changes width class. Screen readers get the names either way, since CSS
 * only hides them visually.
 */
export function Header(props: HeaderProps) {
  const file = () => props.file.get()
  const status = () => props.status.get()
  const people = () => props.people.get()
  const narrow = () => props.narrow.get()
  const buttons = () => props.view.buttons.get()
  const [expanded, setExpanded] = createSignal(false)
  const more = createMemo(() => {
    const hidden = people().length - MAX_FACES
    return hidden > 0 ? `+${hidden}` : undefined
  })

  createEffect(() => {
    narrow()
    setExpanded(false)
  })

  return (
    <header>
      <a className="brand" href="/">
        pedit
      </a>
      <span className="file">
        {file() ?? ''}
        <CommentCount
          count={
            props.files.get().length < 2
              ? (props.commentCounts.get().get(props.current.get()) ?? 0)
              : 0
          }
        />
      </span>
      <span className="status" data-status={status()}>
        <span className="dot" />
        <span>{STATUS_LABELS[status()]}</span>
      </span>
      <ul
        className="people"
        aria-label="Participants"
        data-expanded={expanded() ? '' : undefined}
        data-more={more()}
        onClick={() => setExpanded(narrow() && !expanded())}
      >
        {people().map((p) => (
          <li key={p.clientId} title={label(p)} style={`--c: ${p.color}`}>
            <span className="avatar">
              {initials(p.name)}
              {p.avatar ? (
                <img
                  src={p.avatar}
                  alt=""
                  referrerpolicy="no-referrer"
                  // Unknown to Gravatar (d=404) or blocked: keep the initials.
                  onError={(e) => (e.currentTarget as HTMLElement).remove()}
                />
              ) : null}
            </span>
            <span>{label(p)}</span>
          </li>
        ))}
      </ul>
      <div
        className="view-switch"
        role="group"
        aria-label="View"
        hidden={buttons().every((b) => b.hidden)}
      >
        {buttons().map((b) => (
          <button
            key={b.mode}
            type="button"
            data-mode={b.mode}
            hidden={b.hidden}
            aria-pressed={b.pressed ? 'true' : 'false'}
            disabled={b.disabled}
            title={b.title ?? undefined}
            onClick={() => props.view.choose(b.mode)}
          >
            {b.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="icon comments-button"
        title="Comments"
        aria-label="Comments"
        aria-pressed={props.commentsOpen.get() ? 'true' : 'false'}
        hidden={!props.commentable.get()}
        onClick={() => props.onToggleComments()}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d={BUBBLE} />
        </svg>
      </button>
      <Settings model={props.settings} />
    </header>
  )
}
