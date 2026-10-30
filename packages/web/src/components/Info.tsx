'use client'

import { onCleanup, onMount } from '@barefootjs/client'
import { INFO_STEM, INFO_WIDTH, type InfoLink } from '../info.ts'
import { panelBox } from '../settings.ts'

/**
 * The info button and the panel of links it opens: the public relay's terms
 * and privacy policy, and the source. Like the settings, the panel is a
 * popover, so the browser closes it on Escape or an outside click. The links
 * open in a new tab, so following one does not leave the room.
 */
export function Info(props: { links: readonly InfoLink[] }) {
  let button: HTMLButtonElement | undefined
  let panel: HTMLElement | undefined

  onMount(() => {
    const place = (ev: Event) => {
      if ((ev as ToggleEvent).newState !== 'open' || !panel || !button) return
      const b = panelBox(
        button.getBoundingClientRect(),
        document.documentElement.clientWidth,
        INFO_WIDTH,
      )
      panel.style.width = `${b.width}px`
      panel.style.left = `${b.left}px`
      panel.style.top = `${b.top}px`
    }
    panel?.addEventListener('beforetoggle', place)
    onCleanup(() => panel?.removeEventListener('beforetoggle', place))
  })

  return (
    <span className="info-slot">
      <button
        type="button"
        className="icon"
        title="About pedit"
        aria-label="About pedit"
        popovertarget="info"
        ref={(el) => {
          button = el
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d={INFO_STEM} />
        </svg>
      </button>
      <div
        className="info"
        id="info"
        role="dialog"
        aria-label="About pedit"
        popover=""
        ref={(el) => {
          panel = el
        }}
      >
        <ul className="info-links">
          {props.links.map((link) => (
            <li key={link.href}>
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d={link.icon} />
                </svg>
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </span>
  )
}
