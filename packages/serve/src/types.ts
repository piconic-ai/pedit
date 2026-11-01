/** `read` sends `X-Pedit-Role: read`, which pedit enforces. */
export type Role = 'edit' | 'read'

export type ServeEvent =
  | { type: 'started'; path: string }
  | { type: 'stopped'; path: string; reason: 'idle' | 'exited' | 'shutdown' }
  | { type: 'error'; path: string | null; message: string }
