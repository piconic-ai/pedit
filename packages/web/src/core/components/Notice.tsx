'use client'

import type { Readable } from '../store.ts'

export interface NoticeProps {
  message: Readable<string | null>
  /** Images being added right now. */
  uploading: Readable<number>
  onDismiss: () => void
}

/** A line under the header: images being added, or what just went wrong. */
export function Notice(props: NoticeProps) {
  const message = () => props.message.get()
  const busy = () => props.uploading.get() > 0

  return (
    <div className="banner notice" role="status" hidden={!message() && !busy()}>
      <span>{message() ?? (busy() ? 'Adding image…' : '')}</span>
      <button type="button" hidden={!message()} onClick={() => props.onDismiss()}>
        Dismiss
      </button>
    </div>
  )
}
