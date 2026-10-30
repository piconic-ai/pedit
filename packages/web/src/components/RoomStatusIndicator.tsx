'use client'

import { createSignal, onCleanup, onMount } from '@barefootjs/client'
import type { RoomStatus } from '@pedit/protocol'
import type { Readable } from '../store.ts'

export type KeptSyncStatus =
  | 'connecting'
  | 'saving'
  | 'kept'
  | 'synced'
  | 'retrying'
  | 'expired'
  | 'host-closed'
export type HeaderStatus = RoomStatus | KeptSyncStatus
const CLOUD = 'M7 18H6a4 4 0 0 1-.6-7.95 6 6 0 0 1 11.7-1.5A4.5 4.5 0 0 1 18 18Z'
const SPINNER = 'M12 3a9 9 0 1 1-9 9'
const WARNING = 'M12 3 2 21h20L12 3zM12 9v5m0 3v1'
const CLOCK = 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2'
type Description = {
  label: string
  detail: string
  icon: string
  tone: 'ok' | 'working' | 'warning' | 'ended'
}
const STATUS: Record<HeaderStatus, Description> = {
  connected: {
    label: 'Connected',
    detail:
      'Connected to the room. This connection status does not confirm that edits are saved to the host’s file.',
    icon: CLOUD,
    tone: 'ok',
  },
  connecting: {
    label: 'Connecting…',
    detail: 'Connecting to the room and loading its shared text.',
    icon: SPINNER,
    tone: 'working',
  },
  waiting: {
    label: 'Waiting for the host…',
    detail: 'Waiting for the host to reconnect before this room can continue.',
    icon: CLOUD,
    tone: 'working',
  },
  closed: {
    label: 'Ended',
    detail: 'This room has ended. Editing is no longer available.',
    icon: CLOCK,
    tone: 'ended',
  },
  full: {
    label: 'Room full',
    detail: 'This room has reached its participant limit. Try joining again later.',
    icon: WARNING,
    tone: 'warning',
  },
  maintenance: {
    label: 'Maintenance',
    detail: 'The relay is under maintenance. Try connecting again later.',
    icon: WARNING,
    tone: 'warning',
  },
  'client-outdated': {
    label: 'Outdated',
    detail: 'This browser client is outdated. Reload the page to reconnect.',
    icon: WARNING,
    tone: 'warning',
  },
  'server-outdated': {
    label: 'Server outdated',
    detail: 'The relay needs an update before this client can connect.',
    icon: WARNING,
    tone: 'warning',
  },
  disconnected: {
    label: 'Offline',
    detail: 'The connection was lost. Edits may not have reached the host.',
    icon: WARNING,
    tone: 'warning',
  },
  busy: {
    label: 'Busy, retrying…',
    detail: 'The relay is busy. The client will try connecting again.',
    icon: SPINNER,
    tone: 'working',
  },
  'too-large': {
    label: 'Too large',
    detail: 'The room has exceeded its size limit. Editing cannot continue.',
    icon: WARNING,
    tone: 'ended',
  },
  expired: {
    label: 'Time limit',
    detail: 'This room has expired and ended. Editing is no longer available.',
    icon: CLOCK,
    tone: 'ended',
  },
  'log-full': {
    label: 'Room full of edits',
    detail:
      'The relay cannot keep more edits while the host is away. Copy your text; it stays in this browser only.',
    icon: WARNING,
    tone: 'warning',
  },
  'host-closed': {
    label: 'Closed by host',
    detail:
      'The host closed the room. Editing is no longer available, and edits not yet sent are lost.',
    icon: CLOCK,
    tone: 'ended',
  },
  saving: {
    label: 'Sending your edits…',
    detail: 'Sending your edits to the relay. They have not yet been acknowledged as kept.',
    icon: SPINNER,
    tone: 'working',
  },
  kept: {
    label: 'Edits kept',
    detail: 'Edits kept on the relay; waiting for the host to save them to its file.',
    icon: CLOUD,
    tone: 'working',
  },
  synced: {
    label: 'Saved to the host’s file',
    detail:
      'The host has saved the shared text to the host’s file and checkpointed it on the relay.',
    icon: CLOUD,
    tone: 'ok',
  },
  retrying: {
    label: 'Connection lost. Retrying…',
    detail:
      'Connection lost. Retrying… Unacknowledged edits remain in this browser; keep this page open.',
    icon: WARNING,
    tone: 'warning',
  },
}

export function RoomStatusIndicator(props: {
  status: Readable<HeaderStatus>
  hostAway?: Readable<boolean>
}) {
  const description = () => STATUS[props.status.get()]
  const cloud = () => description().icon === CLOUD
  const away = () =>
    props.hostAway?.get() ?? (props.status.get() === 'waiting' || props.status.get() === 'kept')
  const detail = () =>
    cloud()
      ? `The host is ${away() ? 'away' : 'online'}. ${description().detail}`
      : description().detail
  const [open, setOpen] = createSignal(false)
  const [hovered, setHovered] = createSignal(false)
  onMount(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', escape)
    onCleanup(() => window.removeEventListener('keydown', escape))
  })
  const [position, setPosition] = createSignal('')
  const [tooltipId] = createSignal(`room-status-${crypto.randomUUID()}`)
  let button: HTMLButtonElement | undefined
  let clickOpens: boolean | undefined
  const show = () => {
    const rect = button?.getBoundingClientRect()
    if (rect)
      setPosition(
        `left:${Math.max(8, Math.min(rect.left, innerWidth - 328))}px;top:${rect.bottom + 8}px`,
      )
    setOpen(true)
  }
  return (
    <span
      className="room-status"
      data-open={open() ? 'true' : 'false'}
      onMouseEnter={() => {
        setHovered(true)
        show()
      }}
      onMouseLeave={() => {
        setHovered(false)
        if (!button?.matches(':focus')) setOpen(false)
      }}
    >
      <button
        type="button"
        className="status"
        data-status={props.status.get()}
        data-tone={description().tone}
        data-host={cloud() ? (away() ? 'away' : 'online') : undefined}
        data-icon={cloud() ? 'cloud' : description().icon === SPINNER ? 'spinner' : 'symbol'}
        aria-label={detail()}
        aria-describedby={tooltipId()}
        ref={(el) => {
          button = el
        }}
        onFocus={show}
        onBlur={() => {
          if (!hovered()) setOpen(false)
        }}
        onPointerDown={() => {
          clickOpens = !open()
        }}
        onClick={() => {
          const next = clickOpens ?? !open()
          clickOpens = undefined
          if (next) show()
          else setOpen(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(false)
          }
        }}
      >
        <svg
          className="dot"
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
          <path d={description().icon} />
          {cloud() ? <circle className="host-dot" cx="18" cy="18" r="3.5" /> : null}
        </svg>
        <span className="status-label" role="status">
          {description().label}
        </span>
      </button>
      <span className="status-tooltip" role="tooltip" id={tooltipId()} style={position()}>
        {detail()}
      </span>
    </span>
  )
}
