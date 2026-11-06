import { isFinalStatus, type RoomStatus } from '@pedit/protocol'
import { Store } from './store.ts'

export type KeptSyncStatus =
  | 'connecting'
  | 'saving'
  | 'kept'
  | 'synced'
  | 'retrying'
  | 'expired'
  | 'host-closed'
export type HeaderStatus = RoomStatus | KeptSyncStatus

/**
 * Whether nobody edits in this status: while the host is away and the relay
 * keeps nothing (the two minutes it waits for a host that dropped), when
 * the relay has no more room for edits, and once the room has ended. A
 * `kept` room is editable: the relay keeps what is written until the host
 * is back (docs/design/rooms-away.md).
 */
export const isLocked = (status: RoomStatus): boolean =>
  status === 'waiting' || status === 'log-full' || isFinalStatus(status)

/**
 * Whether comments are locked in this status. Beyond the locked statuses, a
 * link that cannot comment never comments; and while the room is kept, only
 * an edit link does, or a comment link when the relay takes comment entries
 * (`kept comments`, protocol version 8). A read link never does.
 */
export const commentsLockedFor = (
  status: RoomStatus,
  writesComments: boolean,
  writesFile: boolean,
  keptComments: boolean,
): boolean =>
  isLocked(status) || !writesComments || (status === 'kept' && !writesFile && !keptComments)

/** Whether the host is away in this status, kept or not. */
export const isHostAway = (status: RoomStatus): boolean =>
  status === 'waiting' || status === 'kept' || status === 'log-full'

/**
 * What the relay keeps from this link while the host is away: its edits (an
 * edit link), its comments (a comment link when the relay takes them), or
 * nothing (a read link, or a comment link the relay does not take them from).
 */
export type KeptKind = 'edits' | 'comments' | null

export const keptKindFor = (
  writesFile: boolean,
  writesComments: boolean,
  keptComments: boolean,
): KeptKind => (writesFile ? 'edits' : writesComments && keptComments ? 'comments' : null)

/**
 * What the page says of a room whose host may be away: the header's status,
 * that the host is away, until when the relay keeps the room, and how many
 * kept edits did not hold. An edit the relay has not logged yet shows as
 * sending, and the page asks before it is closed.
 */
export class AwayView {
  readonly header = new Store<HeaderStatus>('connecting')
  readonly hostAway = new Store(false)
  readonly until = new Store<string | null>(null)
  readonly skipped = new Store(0)
  /** What the relay keeps from this link while the host is away. */
  readonly keeps = new Store<KeptKind>(null)
  /** Whether the room ended because the host closed it on purpose. */
  readonly hostClosed = new Store(false)
  /** Whether the relay has not logged all of this page's edits. */
  pending = false
  #status: RoomStatus = 'connecting'
  #closedByHost = false
  readonly #keptUntil: () => number

  constructor(keptUntil: () => number) {
    this.#keptUntil = keptUntil
  }

  show(status: RoomStatus, closedByHost = false): void {
    this.#status = status
    this.#closedByHost = closedByHost
    const byHost = status === 'closed' && closedByHost
    this.hostClosed.set(byHost)
    this.header.set(byHost ? 'host-closed' : status === 'kept' && this.pending ? 'saving' : status)
    this.hostAway.set(isHostAway(status))
    const kept = status === 'kept' || status === 'log-full'
    this.until.set(kept ? new Date(this.#keptUntil()).toLocaleString() : null)
  }

  setPending(pending: boolean): void {
    this.pending = pending
    this.show(this.#status, this.#closedByHost)
  }

  /** A `beforeunload` listener: asks before leaving edits the relay has not logged. */
  readonly warn = (event: BeforeUnloadEvent): void => {
    if (!this.pending) return
    event.preventDefault()
    event.returnValue = ''
  }
}
