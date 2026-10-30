'use client'

import type { ViewSwitch } from '../view.ts'

export function ViewControls(props: { view: ViewSwitch }) {
  const buttons = () => props.view.buttons.get()
  return (
    <div
      className="view-switch"
      role="group"
      aria-label="View"
      hidden={buttons().every((b) => b.hidden)}
    >
      {buttons().map((b) => (
        <button
          key={b.mode}
          type="button"
          data-mode={b.mode}
          hidden={b.hidden}
          aria-pressed={b.pressed ? 'true' : 'false'}
          disabled={b.disabled}
          title={b.title ?? undefined}
          onClick={() => props.view.choose(b.mode)}
        >
          {b.label}
        </button>
      ))}
    </div>
  )
}
