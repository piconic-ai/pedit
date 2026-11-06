'use client'

import type { ContextMenu } from '../menu.ts'

/** Draws a ContextMenu (menu.ts): its items, separators and shortcuts, at its point. */
export function Menu(props: { menu: ContextMenu }) {
  const state = () => props.menu.state.get()

  return (
    <div
      className="context-menu"
      role="menu"
      hidden={!state().open}
      style={`left: ${state().left}px; top: ${state().top}px`}
      onKeyDown={(e) => props.menu.onKey(e)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state().entries.map((entry, i) =>
        entry.separator ? (
          <div key={`${i}-`} className="context-menu-separator" role="separator" />
        ) : (
          <button
            key={`${i}-${entry.label}`}
            type="button"
            role="menuitem"
            tabindex={-1}
            disabled={entry.disabled}
            aria-keyshortcuts={entry.aria}
            onClick={() => props.menu.pick(i)}
          >
            <span>{entry.label}</span>
            {entry.kbd ? <kbd>{entry.kbd}</kbd> : null}
          </button>
        ),
      )}
    </div>
  )
}
