import type { Room } from './open-room.ts'
import { mountComponent } from './render.ts'
import './components/EndedBanner.tsx'
import './components/Notice.tsx'

export interface BannerOptions {
  /** The reader pressed Reconnect or Reload; the page decides what that means. */
  onReconnect: () => void
  /** The text Copy puts on the clipboard; the room's file by default. */
  text?: () => string
}

/** The banner for a room that is closed, full, out of time, or waiting for its host. */
export function mountBanner(parent: HTMLElement, room: Room, opts: BannerOptions): () => void {
  const { away } = room
  return mountComponent(parent, 'EndedBanner', {
    status: room.status,
    timeLimit: room.timeLimit,
    text: opts.text ?? (() => room.text.toString()),
    keptUntil: away.until,
    keeps: away.keeps,
    skipped: away.skipped,
    hostClosed: away.hostClosed,
    onReconnect: opts.onReconnect,
  })
}

/** The line under the header: images being added, or what just went wrong. */
export function mountNotice(parent: HTMLElement, room: Room): () => void {
  return mountComponent(parent, 'Notice', {
    message: room.notices.message,
    uploading: room.attachments.uploading,
    onDismiss: () => room.notices.dismiss(),
  })
}
