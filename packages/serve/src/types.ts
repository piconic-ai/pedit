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

/**
 * A file's room as pedit reports it: `host` is `here` while pedit shares it now, `away` while it is
 * kept without pedit. `keep` is in seconds; `ends` is when the room ends (Unix ms) and `lifeEnd`
 * the end of its life, which caps it.
 */
export interface ShareStatus {
  room: string
  links: { edit: string; comment?: string; read: string }
  keep: number
  host: 'here' | 'away'
  ends: number
  lifeEnd: number
}

/** One comment of a thread. `time` is RFC 3339 in UTC. Text is cleaned as the browser cleans it. */
export interface CommentMessage {
  id: string
  author: string
  time: string
  body: string
}

/**
 * A thread of the file. `from` and `to` are where its anchor is in the text now, in UTF-16
 * code units of the room's document (a file with CRLF line endings counts a line break as one),
 * or `null` when it cannot be placed: its text was deleted, or it is on cells or a node. `cut`
 * counts the oldest comments left out so that the event fits.
 */
export interface CommentThread {
  id: string
  quote: string
  resolved: boolean
  from: number | null
  to: number | null
  cut?: number
  messages: CommentMessage[]
}

/** What a started thread is called, and its first comment. */
export interface StartedThread {
  thread: string
  message: string
}

/** The range of a new thread: `[from, to)` of the text, in UTF-16 code units, and its first comment. */
export interface CommentRange {
  from: number
  to: number
  body: string
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
  /**
   * The file's threads as they are, while it is shared: once when sharing starts, and when the
   * comments, or the text they point into, change. `more` counts threads pedit left out so that
   * the event fits.
   */
  | { type: 'comments'; path: string; threads: CommentThread[]; more?: number }
  /** The room ended, possibly without the app asking: the relay expired or closed it. */
  | { type: 'room_ended'; path: string; reason: string }
  | ({ path: string } & Omit<Shared, 'type'> & { type: 'shared' })
  /** `unshare` (or `close` on a live room) left the room. */
  | { type: 'unshared'; path: string }
