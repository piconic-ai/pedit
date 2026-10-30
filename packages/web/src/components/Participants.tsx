'use client'

import { createEffect, createMemo, createSignal } from '@barefootjs/client'
import { initials } from '../identity.ts'
import type { Participant } from '../room.ts'
import type { Readable } from '../store.ts'

const MAX_FACES = 3

/** What a participant's link lets them do, when it is less than editing. */
const ACCESS_LABELS: Partial<Record<string, string>> = {
  comment: 'comment only',
  read: 'read only',
}

function label(p: Participant): string {
  const notes = [
    p.isHost ? 'host' : '',
    (p.access && ACCESS_LABELS[p.access]) ?? '',
    p.isSelf ? 'you' : '',
  ].filter(Boolean)
  return notes.length > 0 ? `${p.name} (${notes.join(', ')})` : p.name
}

export function Participants(props: {
  people: Readable<readonly Participant[]>
  narrow: Readable<boolean>
}) {
  const people = () => props.people.get()
  const narrow = () => props.narrow.get()
  const [expanded, setExpanded] = createSignal(false)
  const more = createMemo(() => {
    const hidden = people().length - MAX_FACES
    return hidden > 0 ? `+${hidden}` : undefined
  })

  createEffect(() => {
    narrow()
    setExpanded(false)
  })

  return (
    <ul
      className="people"
      aria-label="Participants"
      data-expanded={expanded() ? '' : undefined}
      data-more={more()}
      onClick={() => setExpanded(narrow() && !expanded())}
    >
      {people().map((p) => (
        <li key={p.clientId} title={label(p)} style={`--c: ${p.color}`}>
          <span className="avatar">
            {initials(p.name)}
            {p.avatar ? (
              <img
                src={p.avatar}
                alt=""
                referrerpolicy="no-referrer"
                // Unknown to Gravatar (d=404) or blocked: keep the initials.
                onError={(e) => (e.currentTarget as HTMLElement).remove()}
              />
            ) : null}
          </span>
          <span>{label(p)}</span>
        </li>
      ))}
    </ul>
  )
}
