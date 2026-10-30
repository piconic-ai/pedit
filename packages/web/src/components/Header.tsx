'use client'

import { createEffect, createMemo, createSignal } from '@barefootjs/client'
import type { Access, FileEntry, RoomStatus } from '@pedit/protocol'
import { initials } from '../identity.ts'
import type { Participant } from '../room.ts'
import type { SettingsModel } from '../settings.ts'
import type { Readable } from '../store.ts'
import type { ViewSwitch } from '../view.ts'
import { CommentCount } from './FileTabs.tsx'
import { Settings } from './Settings.tsx'
import { ViewControls } from './ViewControls.tsx'

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
  /** What this browser's link lets it do; edit when not given. */
  access?: Access
  /** Opens the Share menu next to its button; no button without it. */
  onShare?: (button: HTMLElement) => void
}

/** What the header says of a link below edit, and its longer explanation. */
const ACCESS_CHIPS: Partial<Record<Access, { text: string; title: string }>> = {
  comment: { text: 'Comment only', title: 'You can read this file and comment on it.' },
  read: { text: 'Read only', title: 'You can read this file and its comments.' },
}

/** A speech bubble, on a 24 by 24 grid. */
const BUBBLE = 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'

/** What a participant's link lets them do, when it is less than editing. */
const ACCESS_LABELS: Partial<Record<string, string>> = {
  comment: 'comment only',
  read: 'read only',
}

function label(p: Participant): string {
  const notes = [
    p.isHost ? 'host' : '',
    (p.access && ACCESS_LABELS[p.access]) ?? '',
    p.isSelf ? 'you' : '',
  ].filter(Boolean)
  return notes.length > 0 ? `${p.name} (${notes.join(', ')})` : p.name
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
      {props.access && ACCESS_CHIPS[props.access] ? (
        <span className="access" title={ACCESS_CHIPS[props.access]?.title}>
          {ACCESS_CHIPS[props.access]?.text}
        </span>
      ) : null}
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
      <ViewControls view={props.view} />
      {props.onShare ? (
        <button
          type="button"
          className="share-button"
          aria-haspopup="menu"
          onClick={(e) => props.onShare?.(e.currentTarget as HTMLElement)}
        >
          Share
        </button>
      ) : null}
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
