import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { Access } from './access.ts'

/*
 * Everyone in a room is listed among its participants, by the awareness
 * state each peer sends of itself (#122). Peers below an editor must not be
 * able to hide or change what others show of an editor, nor pass for one, so
 * a RoomClient applies a peer's awareness by these rules:
 *
 * - A frame holds one entry. Nobody forwards another client's state, or its
 *   removal: every peer times others out on its own.
 * - For each client ID, the client remembers the highest access it heard
 *   the ID's state with, for the session, and drops states for it from below
 *   that. What a participant is shown as (editor, comment only, read only),
 *   and the host's own fields (role, file, format, attachments), follow from
 *   that access, never from the state.
 * - A signed state is applied at the next clock after the one the client
 *   holds, so a clock someone below claimed first does not hold it back;
 *   signed frames come in order already (frame.ts). States from below may
 *   not claim clocks past MAX_WIRE_CLOCK, so that next clock stays exact.
 * - The client follows at most MAX_UNSIGNED clients that sign nothing at
 *   once, and forgets each when its state is gone, so ones that come and go
 *   take no room. It sends its own state to newcomers at most every
 *   ANNOUNCE_EVERY_MS.
 * - When a client ID's access rises, how it is shown may change though its
 *   state does not, so the client says so (onAccess).
 *
 * Keep in sync with internal/protocol/presence.go.
 */
export const MAX_WIRE_CLOCK = 2 ** 32
export const MAX_UNSIGNED = 64
export const ANNOUNCE_EVERY_MS = 2000

const RANK: Record<Access, number> = { read: 0, comment: 1, edit: 2 }

/** Remembers the highest access each client ID spoke with. */
export class Presence {
  private readonly access = new Map<number, Access>()

  /**
   * Whether a state for `id`, from a peer with this access, may be applied,
   * remembering the access when it is the highest yet. `active` tells
   * whether the client holds a state for `id` now, and `unsigned` counts the
   * clients that sign nothing whose states it holds.
   */
  admit(id: number, access: Access, active: boolean, unsigned: () => number): boolean {
    const seen = this.access.get(id)
    if (seen && RANK[access] < RANK[seen]) return false
    if (access === 'read' && !active && unsigned() >= MAX_UNSIGNED) return false
    if (!seen || RANK[access] > RANK[seen]) this.access.set(id, access)
    return true
  }

  /** Forgets a client that signed nothing; access from above is kept for the session. */
  forget(id: number): void {
    if (this.access.get(id) === 'read') this.access.delete(id)
  }

  of(id: number): Access | undefined {
    return this.access.get(id)
  }
}

/** The one entry of an awareness update. */
export interface AwarenessEntry {
  id: number
  clock: number
  state: string
}

/** Reads an awareness update that must hold one entry; throws otherwise. */
export function decodeAwarenessEntry(update: Uint8Array): AwarenessEntry {
  const decoder = decoding.createDecoder(update)
  const count = decoding.readVarUint(decoder)
  if (count !== 1) throw new Error(`awareness of ${count} clients in one frame`)
  const entry = {
    id: decoding.readVarUint(decoder),
    clock: decoding.readVarUint(decoder),
    state: decoding.readVarString(decoder),
  }
  // lib0 reads past the end without complaint.
  if (decoder.pos !== update.length) throw new Error('malformed awareness entry')
  return entry
}

export function encodeAwarenessEntry(entry: AwarenessEntry): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 1)
  encoding.writeVarUint(encoder, entry.id)
  encoding.writeVarUint(encoder, entry.clock)
  encoding.writeVarString(encoder, entry.state)
  return encoding.toUint8Array(encoder)
}
