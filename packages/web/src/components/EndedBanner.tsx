'use client'

import { createSignal, onCleanup } from '@barefootjs/client'
import { MAX_FRAME_BYTES, type RoomStatus } from '@pedit/protocol'
import { copyText } from '../copy.ts'
import type { Readable } from '../store.ts'
import { timeLimitText } from '../timelimit.ts'

const RESET_MS = 2000

export interface EndedBannerProps {
  status: Readable<RoomStatus>
  /** The whole document, read when Copy is pressed. */
  text: () => string
  /** The relay's time limit in seconds, once it has said so. */
  timeLimit?: Readable<number | undefined>
  onReconnect: () => void
  /** While the host is away and the relay keeps the room: until when, as the person reads it. */
  keptUntil?: Readable<string | null>
  /** How many kept edits did not hold, and were left out. */
  skipped?: Readable<number>
  /** Whether the host closed the room on purpose (`pedit --close`). */
  hostClosed?: Readable<boolean>
  clipboard?: Pick<Clipboard, 'writeText'>
  resetMs?: number
}

const LABELS = { idle: 'Copy text', copied: 'Copied', failed: 'Could not copy' } as const

/** Why the room will not come back, for each status that says so. */
const STATIC_MESSAGES: Partial<Record<RoomStatus, string>> = {
  closed: 'This session has ended: the host is not connected. You can still copy the text.',
  waiting:
    "The host's connection dropped. Waiting for them to come back: until then you can read, but not edit.",
  maintenance:
    'The relay is closed for maintenance. Once it is back and the host has reconnected, Reconnect brings you back. You can still copy the text.',
  full: 'This room is full: its relay takes only so many people at once. Try again when someone leaves, or ask the host to run their own relay, which can take more.',
  'client-outdated':
    'This page is out of date: reload it to keep editing. You can still copy the text.',
  'server-outdated':
    'The server is older than this page and cannot connect it. You can still copy the text.',
  'too-large': `This document grew too large to share: pedit shares files up to about ${MAX_FRAME_BYTES / (1024 * 1024)} MiB for now. Your latest changes may not have reached the others. You can still copy the text.`,
}

function message(status: RoomStatus, limit: number | undefined): string | undefined {
  if (status === 'expired') {
    return `This room reached its ${timeLimitText(limit)} on the relay and has ended. Ask the host to run pedit again for a new link. You can still copy the text.`
  }
  return STATIC_MESSAGES[status]
}

/**
 * Shown while the host is away (the room waits for it to come back, and
 * nobody edits), and once the room closes, which it does as soon as the host leaves, or
 * when the server speaks another protocol version than this page, or when the
 * room had no place for us, or when the document grew too large to share, or when the room reached
 * the relay's time limit.
 * Copy text matters on phones, where selecting the whole document by hand
 * does not work: the editor only draws the lines on screen. A full room never
 * sent us any text, so there is none to copy.
 */
export function EndedBanner(props: EndedBannerProps) {
  const status = () => props.status.get()
  const why = () => {
    if (status() === 'kept') {
      const left = props.skipped?.get() ?? 0
      return `The host is away. This room stays open until ${props.keptUntil?.get() ?? 'then'}, and your edits are kept for the host to take in.${left ? ` Skipped invalid updates: ${left}.` : ''}`
    }
    if (status() === 'log-full')
      return 'The host is away and the relay cannot keep more edits. Copy the text to save what you wrote since.'
    if (status() === 'closed' && props.hostClosed?.get())
      return 'The host closed the room. Editing has ended. You can still copy the text.'
    return message(status(), props.timeLimit?.get())
  }
  const [copy, setCopy] = createSignal<keyof typeof LABELS>('idle')
  let timer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(timer))

  const copyAll = async () => {
    const clipboard = 'clipboard' in props ? props.clipboard : navigator.clipboard
    setCopy((await copyText(props.text(), clipboard)) ? 'copied' : 'failed')
    clearTimeout(timer)
    timer = setTimeout(() => setCopy('idle'), props.resetMs ?? RESET_MS)
  }

  return (
    <div className="banner" role="status" hidden={!why()}>
      <span>{why() ?? ''}</span>
      <button type="button" onClick={copyAll} hidden={status() === 'full'}>
        {LABELS[copy()]}
      </button>
      <button
        type="button"
        onClick={() => props.onReconnect()}
        hidden={['expired', 'waiting', 'kept', 'log-full'].includes(status())}
      >
        {status() === 'client-outdated' ? 'Reload' : 'Reconnect'}
      </button>
    </div>
  )
}
