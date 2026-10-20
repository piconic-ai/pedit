'use client'

import type { FileEntry } from '@pedit/protocol'
import type { Readable } from '../store.ts'

export interface FileTabsProps {
  /** The files the room shares, as the host listed them; file 0 first. */
  files: Readable<readonly FileEntry[]>
  /** The id of the file on screen. */
  current: Readable<number>
  onOpen: (id: number) => void
}

/**
 * The room's files, one tab each, under the header. Shown only once the
 * host shares more than one file; the header names the file on screen.
 */
export function FileTabs(props: FileTabsProps) {
  const files = () => props.files.get()
  const current = () => props.current.get()

  return (
    <nav className="file-tabs" aria-label="Files" hidden={files().length < 2}>
      {files().map((f) => (
        <button
          key={f.id}
          type="button"
          title={f.path}
          aria-current={f.id === current() ? 'page' : undefined}
          onClick={() => props.onOpen(f.id)}
        >
          {f.path}
        </button>
      ))}
    </nav>
  )
}
