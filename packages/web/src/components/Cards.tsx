'use client'

import { createSignal, onCleanup, onMount } from '@barefootjs/client'
import { prefersStill, TITLE, type TypingFrame, typingScript, WORD_AFTER } from '../landing.ts'

/** The page at `/`, for someone who opened pedit without a room link. */
export function Landing() {
  // Two peers edit the page at once (landing.ts); screen readers get the finished text.
  const frames = typingScript()
  const last = frames[frames.length - 1] as TypingFrame
  const still = prefersStill()
  const [frame, setFrame] = createSignal(still ? last : (frames[0] as TypingFrame))

  onMount(() => {
    if (still) return
    const timers = frames.map((f) => setTimeout(() => setFrame(f), f.at))
    onCleanup(() => {
      for (const t of timers) clearTimeout(t)
    })
  })

  return (
    <div className="center">
      <div className="landing" data-done={frame().done ? '' : undefined}>
        <h1>
          <span className="visually-hidden">{TITLE}</span>
          <span aria-hidden="true">
            <Keys text={frame().title} />
            <span className="peer-caret" />
            <span className="untyped">{TITLE.slice(frame().title.length)}</span>
          </span>
        </h1>
        <p>
          <span className="visually-hidden">{`Pair edit your ${WORD_AFTER} files.`}</span>
          <span aria-hidden="true">
            {'Pair edit your '}
            <span className="word" data-selected={frame().selected ? '' : undefined}>
              <Keys text={frame().word} />
            </span>
            <span className="peer-caret" />
            {' files.'}
          </span>
        </p>
        <a href="https://github.com/piconic-ai/pedit" aria-label="GitHub">
          <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
      </div>
    </div>
  )
}

/** Typed text, a span per letter so each new one can fade in as it lands. */
function Keys(props: { text: string }) {
  return (
    <span>
      {Array.from(props.text).map((ch, i) => (
        // Keyed by letter too: a letter typed over another is a new key.
        <span key={`${i}${ch}`} className="key">
          {ch}
        </span>
      ))}
    </span>
  )
}

/** A room link that lost its key, the part after #. */
export function IncompleteLink() {
  return (
    <div className="center">
      <div className="card">
        <h1>Open your shared link again</h1>
        <p>
          Part of the link may have been lost during sign-in. Please open the full URL you received
          again, including the part after #.
        </p>
      </div>
    </div>
  )
}

/**
 * A browser that cannot check signatures (Ed25519, #122): opening the room
 * anyway would show changes nobody checked.
 */
export function UnsupportedBrowser() {
  return (
    <div className="center">
      <div className="card">
        <h1>Update your browser</h1>
        <p>
          This browser cannot check who changed the file, so pedit cannot open this link safely.
          Update your browser and open the link again.
        </p>
      </div>
    </div>
  )
}

/** Asks for the name others see next to this browser's cursor. */
export function JoinCard(props: { onJoin: (name: string) => void }) {
  let input: HTMLInputElement | undefined
  onMount(() => input?.focus())

  const submit = (ev: Event) => {
    ev.preventDefault()
    const name = input?.value.trim()
    if (name) props.onJoin(name)
  }

  return (
    <div className="center">
      <div className="card">
        <h1>Join the room</h1>
        <p>Others will see this name next to your cursor.</p>
        <form onSubmit={submit}>
          <input
            name="name"
            placeholder="Your name"
            autocomplete="name"
            required
            maxlength={40}
            ref={(el) => {
              input = el
            }}
          />
          <button type="submit">Join</button>
        </form>
      </div>
    </div>
  )
}
