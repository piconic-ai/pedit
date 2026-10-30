'use client'

import type { Readable } from '../store.ts'

export function KeptTextHeader(props: {
  status: Readable<string>
  deadline: Readable<string | null>
  readOnly: boolean
}) {
  return (
    <>
      <header>
        <a className="brand" href="/">
          pedit
        </a>
        <span className="file">Shared text</span>
        <span hidden={!props.readOnly}>Read only</span>
        <span role="status">{props.status.get()}</span>
      </header>
      <p className="banner" role="status" hidden={props.deadline.get() === null}>
        The host is away. This room stays open until {props.deadline.get() ?? ''}.
      </p>
    </>
  )
}
