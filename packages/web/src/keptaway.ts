import { isFinalStatus, type RoomStatus } from '@pedit/protocol'
import type { HeaderStatus } from './components/RoomStatusIndicator.tsx'
import { Store } from './store.ts'

/**
 * Whether nobody edits in this status: while the host is away and the relay
 * keeps nothing (the two minutes it waits for a host that dropped), when
 * the relay has no more room for edits, and once the room has ended. A
 * `kept` room is editable: the relay keeps what is written until the host
 * is back (docs/design/rooms-away.md).
 */
export const isLocked = (status: RoomStatus): boolean =>
  status === 'waiting' || status === 'log-full' || isFinalStatus(status)

/** Whether the host is away in this status, kept or not. */
export const isHostAway = (status: RoomStatus): boolean =>
  status === 'waiting' || status === 'kept' || status === 'log-full'

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
  /** Whether the room ended because the host closed it on purpose. */
  readonly hostClosed = new Store(false)
  /** Whether the relay has not logged all of this page's edits. */
  pending = false
  #status: RoomStatus = 'connecting'
  readonly #keptUntil: () => number

  constructor(keptUntil: () => number) {
    this.#keptUntil = keptUntil
  }

  show(status: RoomStatus, closedByHost = false): void {
    this.#status = status
    const byHost = status === 'closed' && closedByHost
    this.hostClosed.set(byHost)
    this.header.set(byHost ? 'host-closed' : status === 'kept' && this.pending ? 'saving' : status)
    this.hostAway.set(isHostAway(status))
    const kept = status === 'kept' || status === 'log-full'
    this.until.set(kept ? new Date(this.#keptUntil()).toLocaleString() : null)
  }

  setPending(pending: boolean): void {
    this.pending = pending
    this.show(this.#status)
  }

  /** A `beforeunload` listener: asks before leaving edits the relay has not logged. */
  readonly warn = (event: BeforeUnloadEvent): void => {
    if (!this.pending) return
    event.preventDefault()
    event.returnValue = ''
  }
}
