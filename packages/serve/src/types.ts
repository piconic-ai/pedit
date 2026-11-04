/** `read` sends `X-Pedit-Role: read`, which pedit enforces. */
export type Role = 'edit' | 'read'

export type ServeEvent =
  /** `version` and `serve` come from pedit's `listening` event; a pedit that predates them leaves them out. */
  | { type: 'started'; path: string; version?: string; serve?: number }
  | { type: 'stopped'; path: string; reason: 'idle' | 'exited' | 'shutdown' }
  | { type: 'error'; path: string | null; message: string }
  /** A newer pedit is out. Sent once per version, whichever child saw it first. */
  | { type: 'update_available'; version: string; url: string; security: boolean }
