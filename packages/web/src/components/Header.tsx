'use client'

import type { Access, FileEntry } from '@pedit/protocol'
import type { Participant } from '../room.ts'
import type { SettingsModel } from '../settings.ts'
import type { Readable } from '../store.ts'
import type { ViewSwitch } from '../view.ts'
import { CommentCount } from './FileTabs.tsx'
import { Participants } from './Participants.tsx'
import { type HeaderStatus, RoomStatusIndicator } from './RoomStatusIndicator.tsx'
import { Settings } from './Settings.tsx'
import { ViewControls } from './ViewControls.tsx'

export interface HeaderProps {
  /** The host's file name, once the host has told us. */
  file: Readable<string | null>
  status: Readable<HeaderStatus>
  hostAway?: Readable<boolean>
  participants?: { people: Readable<readonly Participant[]>; narrow: Readable<boolean> }
  view: ViewSwitch
  settings: SettingsModel
  comments?: {
    counts: Readable<ReadonlyMap<number, number>>
    files: Readable<readonly FileEntry[]>
    current: Readable<number>
    commentable: Readable<boolean>
    open: Readable<boolean>
    onToggle: () => void
  }
  /** What this browser's link lets it do; edit when not given. */
  access?: Access
  /** Opens the Share menu next to its button; no button without it. */
  onShare?: (button: HTMLElement) => void
}

/** What the header says of a link below edit, and its longer explanation. */
const ACCESS_CHIPS: Partial<Record<Access, { text: string; title: string }>> = {
  comment: { text: 'Comment only', title: 'You can read this file and comment on it.' },
  read: { text: 'Read only', title: 'You can read this file.' },
}

/** A speech bubble, on a 24 by 24 grid. */
const BUBBLE = 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'

/**
 * The top bar: file name, connection status, participants, view buttons and
 * settings. On narrow screens the participants collapse to a row of faces;
 * tapping it shows their names, and the row folds again whenever the screen
 * changes width class. Screen readers get the names either way, since CSS
 * only hides them visually.
 */
export function Header(props: HeaderProps) {
  return (
    <header>
      <a className="brand" href="/">
        pedit
      </a>
      <span className="file">
        {props.file.get() ?? ''}
        {props.comments ? (
          <CommentCount
            count={
              props.comments.files.get().length < 2
                ? (props.comments.counts.get().get(props.comments.current.get()) ?? 0)
                : 0
            }
          />
        ) : null}
      </span>
      <RoomStatusIndicator status={props.status} hostAway={props.hostAway} />
      {props.access && ACCESS_CHIPS[props.access] ? (
        <span className="access" title={ACCESS_CHIPS[props.access]?.title}>
          {ACCESS_CHIPS[props.access]?.text}
        </span>
      ) : null}
      {props.participants ? (
        <Participants people={props.participants.people} narrow={props.participants.narrow} />
      ) : null}
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
      {props.comments ? (
        <button
          type="button"
          className="icon comments-button"
          title="Comments"
          aria-label="Comments"
          aria-pressed={props.comments.open.get() ? 'true' : 'false'}
          hidden={!props.comments.commentable.get()}
          onClick={() => props.comments?.onToggle()}
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
      ) : null}
      <Settings model={props.settings} />
    </header>
  )
}
