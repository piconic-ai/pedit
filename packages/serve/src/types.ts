/** `read` sends `X-Pedit-Role: read`, which pedit enforces. */
export type Role = 'edit' | 'read'

export type Access = 'edit' | 'comment' | 'read'

export interface ShareOptions {
  /** Page origins the relay admits to this room (at most 4). */
  origins?: string[]
  /** How long the relay keeps the room after the host leaves, e.g. `1d`; `0` makes a live room. */
  keep?: string
  /** The relay's URL; default is the project's, or https://edit.piconic.ai. */
  relay?: string
  /** The user's answer to a `choice` result. */
  choice?: 'room' | 'app' | 'later'
}

/** The room is open. A link is `<room>.<fragment>`: the app puts its page URL and `#` in front. */
export interface Shared {
  type: 'shared'
  room: string
  links: { edit: string; comment?: string; read: string }
  /** Unix ms; 0 when the relay keeps nothing. */
  keptUntil: number
  resumed: boolean
}

/** The file has a kept room of another history: ask the user, then share again with `choice`. */
export interface ShareChoice {
  type: 'choice'
  room: string
  choices: { choice: 'room' | 'app' | 'later'; text?: number }[]
}

/** Choosing `app` ended the kept room instead of sharing. */
export interface ShareClosed {
  type: 'closed'
}

export type ShareResult = Shared | ShareChoice | ShareClosed

export interface Peer {
  name: string
  access: Access
}

export type ServeEvent =
  /** `version` and `serve` come from pedit's `listening` event; a pedit that predates them leaves them out. */
  | { type: 'started'; path: string; version?: string; serve?: number }
  | { type: 'stopped'; path: string; reason: 'idle' | 'exited' | 'shutdown' }
  | { type: 'error'; path: string | null; message: string }
  /** A newer pedit is out. Sent once per version, whichever child saw it first. */
  | { type: 'update_available'; version: string; url: string; security: boolean }
  /** Who is in the room, when it changed. `more` counts people pedit left out of the list. */
  | { type: 'peers'; path: string; peers: Peer[]; more?: number }
  /** The room ended, possibly without the app asking: the relay expired or closed it. */
  | { type: 'room_ended'; path: string; reason: string }
  | ({ path: string } & Omit<Shared, 'type'> & { type: 'shared' })
