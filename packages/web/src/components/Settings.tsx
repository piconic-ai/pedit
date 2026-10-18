'use client'

import { createEffect, createMemo, createSignal, onCleanup, onMount } from '@barefootjs/client'
import { providerLabel } from '../alwaysload.ts'
import {
  CHEVRON_LEFT,
  CHEVRON_RIGHT,
  GEAR,
  galleryTarget,
  panelBox,
  type SettingsModel,
} from '../settings.ts'
import { ThemePreview } from './ThemePreview.tsx'

/**
 * The gear button and the panel of per-browser preferences it opens. The
 * panel is a popover, so the browser handles closing it on Escape or an
 * outside click. The theme opens a page of cards in place of the settings:
 * a listbox that applies each theme as it is clicked or the arrow keys reach
 * it, so the effect shows behind the panel. Enter, Escape or the back button
 * return to the settings.
 */
export function Settings(props: { model: SettingsModel }) {
  const m = props.model
  const theme = () => m.theme.get()
  const fontSize = () => m.fontSize.get()
  const lineHeight = () => m.lineHeight.get()
  const wrap = () => m.wrap.get()
  const vim = () => m.vim.get()
  const alwaysLoad = () => m.alwaysLoad.get()

  const [gallery, setGallery] = createSignal(false)
  const current = createMemo(() => m.themes.find((t) => t.id === theme()))
  // Light themes, then dark: the order the arrow keys walk.
  const ordered = createMemo(() => [
    ...m.themes.filter((t) => t.scheme === 'light'),
    ...m.themes.filter((t) => t.scheme === 'dark'),
  ])

  let gear: HTMLButtonElement | undefined
  let panel: HTMLElement | undefined
  let box: HTMLElement | undefined
  let row: HTMLButtonElement | undefined

  onMount(() => {
    const place = (ev: Event) => {
      if ((ev as ToggleEvent).newState !== 'open' || !panel || !gear) return
      // Always open on the settings themselves, not a page left open last time.
      setGallery(false)
      const b = panelBox(gear.getBoundingClientRect(), document.documentElement.clientWidth)
      panel.style.width = `${b.width}px`
      panel.style.left = `${b.left}px`
      panel.style.top = `${b.top}px`
      panel.style.maxHeight = b.maxHeight
    }
    panel?.addEventListener('beforetoggle', place)
    onCleanup(() => panel?.removeEventListener('beforetoggle', place))
  })

  // Keep the chosen card in view as the arrow keys move through the gallery.
  createEffect(() => {
    const id = theme()
    if (!gallery()) return
    box?.querySelector(`[data-value="${id}"]`)?.scrollIntoView?.({ block: 'nearest' })
  })

  const openGallery = () => {
    setGallery(true)
    if (panel) panel.scrollTop = 0
    box?.focus()
    box?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'center' })
  }
  const closeGallery = () => {
    setGallery(false)
    row?.focus()
  }
  const choose = (id: string) => {
    if (id !== theme()) m.setTheme(id)
  }
  const onGalleryKey = (ev: KeyboardEvent) => {
    const list = ordered()
    const target = galleryTarget(
      ev.key,
      list.findIndex((t) => t.id === theme()),
      list.length,
    )
    if (target !== null) {
      ev.preventDefault()
      const next = list[target]
      if (next) choose(next.id)
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      closeGallery()
    }
  }

  return (
    <span className="settings-slot">
      <button
        type="button"
        className="icon"
        title="Settings"
        aria-label="Settings"
        popovertarget="settings"
        ref={(el) => {
          gear = el
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
          <path d={GEAR} />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      <div
        className="settings"
        id="settings"
        role="dialog"
        aria-label="Settings"
        popover=""
        ref={(el) => {
          panel = el
        }}
      >
        <div className="settings-home" hidden={gallery()}>
          <h2>Settings</h2>
          <div className="settings-list">
            <h3 className="settings-section">Appearance</h3>
            <button
              type="button"
              className="settings-nav"
              aria-haspopup="listbox"
              aria-label={current() ? `Theme: ${current()?.label}` : 'Theme'}
              onClick={openGallery}
              ref={(el) => {
                row = el
              }}
            >
              <span className="settings-nav-preview">
                {current() ? (
                  <ThemePreview theme={current() as NonNullable<ReturnType<typeof current>>} />
                ) : null}
              </span>
              <span className="settings-text">
                <span>Theme</span>
                <span className="settings-nav-value">{current()?.label ?? ''}</span>
              </span>
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
                <path d={CHEVRON_RIGHT} />
              </svg>
            </button>
            <h3 className="settings-section">Text</h3>
            <label className="settings-field settings-range">
              <span>Font size</span>
              <input
                type="range"
                min={String(m.fontSizeRange.min)}
                max={String(m.fontSizeRange.max)}
                step={String(m.fontSizeRange.step)}
                value={String(fontSize())}
                onInput={(e) => m.setFontSize(Number(e.target.value))}
              />
              <output>{`${fontSize()}px`}</output>
            </label>
            <label className="settings-field settings-range">
              <span>Line height</span>
              <input
                type="range"
                min={String(m.lineHeightRange.min)}
                max={String(m.lineHeightRange.max)}
                step={String(m.lineHeightRange.step)}
                value={String(lineHeight())}
                onInput={(e) => m.setLineHeight(Number(e.target.value))}
              />
              <output>{lineHeight().toFixed(1)}</output>
            </label>
            <label className="settings-row">
              <input
                type="checkbox"
                checked={wrap()}
                onChange={(e) => m.setWrap(e.target.checked)}
              />
              <span className="settings-text">
                <span>Wrap long lines</span>
              </span>
            </label>
            <h3 className="settings-section">Editor</h3>
            <label className="settings-row">
              <input type="checkbox" checked={vim()} onChange={(e) => m.setVim(e.target.checked)} />
              <span className="settings-text">
                <span>Vim keybindings</span>
                <small>Only in this browser.</small>
              </span>
            </label>
            <h3 className="settings-section">Preview</h3>
            <p className="settings-note" hidden={alwaysLoad().length > 0}>
              Players load only when you click them.
            </p>
            <ul
              className="settings-providers"
              aria-label="Players that always load"
              hidden={alwaysLoad().length === 0}
            >
              {alwaysLoad().map((id) => (
                <li key={id} className="settings-provider">
                  <span className="settings-text">
                    <span>{`Always load ${providerLabel(id)}`}</span>
                    <small>Only in this browser.</small>
                  </span>
                  <button
                    type="button"
                    className="settings-forget"
                    aria-label={`Forget ${providerLabel(id)}`}
                    onClick={() => m.forgetAlwaysLoad(id)}
                  >
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div
          className="settings-page"
          hidden={!gallery()}
          onKeyDown={(ev) => {
            // Escape goes back one page rather than closing the whole panel.
            if (ev.key !== 'Escape') return
            ev.preventDefault()
            closeGallery()
          }}
        >
          <div className="settings-page-head">
            <button
              type="button"
              className="settings-back"
              title="Back"
              aria-label="Back to settings"
              onClick={closeGallery}
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
                <path d={CHEVRON_LEFT} />
              </svg>
            </button>
            <h2 id="settings-theme-title">Theme</h2>
          </div>
          <div
            className="settings-gallery"
            role="listbox"
            tabindex={0}
            aria-labelledby="settings-theme-title"
            aria-activedescendant={`settings-theme-${theme()}`}
            onKeyDown={onGalleryKey}
            ref={(el) => {
              box = el
            }}
          >
            <div role="group" aria-labelledby="settings-group-light">
              <div className="settings-group-label" id="settings-group-light">
                Light
              </div>
              <div className="settings-cards">
                {m.themes
                  .filter((t) => t.scheme === 'light')
                  .map((t) => (
                    <div
                      key={t.id}
                      role="option"
                      id={`settings-theme-${t.id}`}
                      data-value={t.id}
                      aria-selected={t.id === theme() ? 'true' : 'false'}
                      onClick={() => choose(t.id)}
                    >
                      <ThemePreview theme={t} />
                      <span className="settings-card-label">{t.label}</span>
                    </div>
                  ))}
              </div>
            </div>
            <div role="group" aria-labelledby="settings-group-dark">
              <div className="settings-group-label" id="settings-group-dark">
                Dark
              </div>
              <div className="settings-cards">
                {m.themes
                  .filter((t) => t.scheme === 'dark')
                  .map((t) => (
                    <div
                      key={t.id}
                      role="option"
                      id={`settings-theme-${t.id}`}
                      data-value={t.id}
                      aria-selected={t.id === theme() ? 'true' : 'false'}
                      onClick={() => choose(t.id)}
                    >
                      <ThemePreview theme={t} />
                      <span className="settings-card-label">{t.label}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </span>
  )
}
