'use client'

import type { SettingsModel } from '../settings.ts'
import type { Readable } from '../store.ts'
import type { ViewSwitch } from '../view.ts'
import { Settings } from './Settings.tsx'
import { ViewControls } from './ViewControls.tsx'

export function KeptTextHeader(props: {
  status: Readable<string>
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
        <span className="file">Shared text</span>
        <span hidden={!props.readOnly}>Read only</span>
        <span role="status">{props.status.get()}</span>
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
