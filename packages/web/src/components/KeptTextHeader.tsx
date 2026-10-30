'use client'

import type { SettingsModel } from '../settings.ts'
import type { Readable } from '../store.ts'
import type { ViewSwitch } from '../view.ts'
import { Settings } from './Settings.tsx'
import { ViewControls } from './ViewControls.tsx'

export type KeptSyncStatus = 'connecting' | 'saving' | 'kept' | 'synced' | 'retrying' | 'expired'

const LABELS: Record<KeptSyncStatus, string> = {
  connecting: 'Loading the room…',
  saving: 'Sending your edits…',
  kept: 'Edits kept on the relay; waiting for the host to save them',
  synced: 'Saved to the host’s file',
  retrying: 'Connection lost. Retrying…',
  expired: 'This room has expired.',
}
const ICONS: Record<KeptSyncStatus, string> = {
  connecting: 'M12 3a9 9 0 1 1-9 9',
  saving: 'M12 3a9 9 0 1 1-9 9',
  kept: 'M7 18H6a4 4 0 0 1-.6-7.95 6 6 0 0 1 11.7-1.5A4.5 4.5 0 0 1 19 17M10 17l3 3 6-6',
  synced: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
  retrying: 'M12 3 2 21h20L12 3zM12 9v5m0 3v1',
  expired: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2',
}

export function KeptTextHeader(props: {
  status: Readable<KeptSyncStatus>
  file: Readable<string | null>
  skipped: Readable<number>
  deadline: Readable<string | null>
  view: ViewSwitch
  settings: SettingsModel
  readOnly: boolean
}) {
  return (
    <>
      <header>
        <a className="brand" href="/">
          pedit
        </a>
        <span className="file">{props.file.get() ?? ''}</span>
        <span hidden={!props.readOnly}>Read only</span>
        <span
          className="kept-status"
          data-phase={props.status.get()}
          role="status"
          aria-label={LABELS[props.status.get()]}
          title={LABELS[props.status.get()]}
          tabindex={0}
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d={ICONS[props.status.get()]} />
          </svg>
          <span className="kept-status-label">{LABELS[props.status.get()]}</span>
        </span>
        <span role="status" hidden={props.skipped.get() === 0}>
          Skipped invalid updates: {props.skipped.get()}
        </span>
        <ViewControls view={props.view} />
        <Settings model={props.settings} />
      </header>
      <p className="banner" role="status" hidden={props.deadline.get() === null}>
        The host is away. This room stays open until {props.deadline.get() ?? ''}.
      </p>
    </>
  )
}
