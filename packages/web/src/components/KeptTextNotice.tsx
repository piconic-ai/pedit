'use client'

import type { Readable } from '../store.ts'

export function KeptTextNotice(props: {
  skipped: Readable<number>
  deadline: Readable<string | null>
}) {
  return (
    <>
      <p className="banner" role="status" hidden={props.deadline.get() === null}>
        The host is away. This room stays open until {props.deadline.get() ?? ''}.
      </p>
      <p className="banner" role="status" hidden={props.skipped.get() === 0}>
        Skipped invalid updates: {props.skipped.get()}
      </p>
    </>
  )
}
