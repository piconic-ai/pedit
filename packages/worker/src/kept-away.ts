import { encodeLogEnd, encodeLogged, Kind, withKind } from '@pedit/protocol/kinds'
import { ensureKeptLog, KEPT_LOG_BYTES, KEPT_LOG_ENTRIES } from './kept-text.ts'

/**
 * Storage of a room that outlives its host (docs/design/rooms-away.md): the
 * host's latest snapshot, and a log of the entries editors wrote while it was
 * away. Both are ciphertext the relay cannot read. The log is the table the
 * HTTP kept rooms use (kept-text.ts), under the same limits; a snapshot may
 * be a megabyte, too large for kv, so it has a table of its own.
 */

// kv: set once the room holds a snapshot or a log, so a room that never did has nothing to clear.
const DATA_KEY = 'awayData'
// kv: { tail, cutoff }, the id of the last entry and of the last one a checkpoint dropped.
const LOG_KEY = 'awayLog'

interface AwayLog {
  tail: number
  cutoff: number
}

function ensure(storage: DurableObjectStorage): void {
  ensureKeptLog(storage)
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS kept_away_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), body BLOB NOT NULL)',
  )
  storage.kv.put(DATA_KEY, true)
}

export function awayLog(storage: DurableObjectStorage): AwayLog {
  return storage.kv.get<AwayLog>(LOG_KEY) ?? { tail: 0, cutoff: 0 }
}

function readSnapshot(storage: DurableObjectStorage): Uint8Array | undefined {
  if (storage.kv.get(DATA_KEY) === undefined) return undefined
  const row = storage.sql
    .exec<{ body: ArrayBuffer }>('SELECT body FROM kept_away_snapshot WHERE id = 1')
    .toArray()[0]
  return row && new Uint8Array(row.body)
}

export function hasSnapshot(storage: DurableObjectStorage): boolean {
  return storage.kv.get(DATA_KEY) !== undefined && readSnapshot(storage) !== undefined
}

/** Keeps `bundle` as the room's snapshot, in place of the last one. */
export function storeSnapshot(storage: DurableObjectStorage, bundle: Uint8Array): void {
  ensure(storage)
  storage.sql.exec('INSERT OR REPLACE INTO kept_away_snapshot (id, body) VALUES (1, ?)', bundle)
}

/** Adds an entry to the log with the next id, or returns undefined if the log has no room for it. */
export function appendEntry(storage: DurableObjectStorage, entry: Uint8Array): number | undefined {
  ensure(storage)
  return storage.transactionSync(() => {
    const usage = storage.sql
      .exec<{ bytes: number; count: number }>(
        'SELECT coalesce(sum(length(body)), 0) AS bytes, count(*) AS count FROM kept_text_log',
      )
      .one()
    if (usage.bytes + entry.length > KEPT_LOG_BYTES || usage.count >= KEPT_LOG_ENTRIES)
      return undefined
    const log = awayLog(storage)
    // The relay learns no sender: the entry carries its own, signed and encrypted.
    storage.sql.exec(
      "INSERT INTO kept_text_log (id, body, sender) VALUES (?, ?, '')",
      log.tail + 1,
      entry,
    )
    storage.kv.put(LOG_KEY, { ...log, tail: log.tail + 1 })
    return log.tail + 1
  })
}

/**
 * Stores `bundle` as the snapshot and drops the entries up to `cutoff` from
 * the log, which the host took in. Returns the new cutoff and the tail, or
 * undefined if the cutoff is beyond the log or before the last one.
 */
export function checkpoint(
  storage: DurableObjectStorage,
  cutoff: number,
  bundle: Uint8Array,
): { cutoff: number; tail: number } | undefined {
  ensure(storage)
  return storage.transactionSync(() => {
    const log = awayLog(storage)
    if (cutoff > log.tail || cutoff < log.cutoff) return undefined
    storeSnapshot(storage, bundle)
    storage.sql.exec('DELETE FROM kept_text_log WHERE id <= ?', cutoff)
    storage.kv.put(LOG_KEY, { ...log, cutoff })
    return { cutoff, tail: log.tail }
  })
}

/**
 * What a peer that joins a room whose host is away is sent, in order: the
 * snapshot (kind 5), the entries it has not got (kind 4), and the tail (kind
 * 6). `after` is the last entry the peer holds, from its X-Pedit-After header.
 * Without it a guest is sent the snapshot and the whole log; the host is
 * sent the snapshot only if the log was cut after what it holds.
 */
export function replay(
  storage: DurableObjectStorage,
  after: number | undefined,
  host: boolean,
): Uint8Array[] {
  const log = awayLog(storage)
  const known = after !== undefined && after <= log.tail
  const start = known ? after : host ? 0 : log.cutoff
  const messages: Uint8Array[] = []
  const snapshot = readSnapshot(storage)
  if (snapshot && (known || host ? start < log.cutoff : true))
    messages.push(withKind(Kind.Replay, snapshot))
  if (storage.kv.get(DATA_KEY) !== undefined) {
    const rows = storage.sql
      .exec<{ id: number; body: ArrayBuffer }>(
        'SELECT id, body FROM kept_text_log WHERE id > ? ORDER BY id',
        start,
      )
      .toArray()
    for (const row of rows) messages.push(encodeLogged(row.id, new Uint8Array(row.body)))
  }
  messages.push(encodeLogEnd(log.tail))
  return messages
}

/** Deletes the snapshot and the log, as the room ends. */
export function clearAway(storage: DurableObjectStorage): void {
  if (storage.kv.get(DATA_KEY) === undefined) return
  storage.sql.exec('DROP TABLE IF EXISTS kept_away_snapshot')
  storage.sql.exec('DROP TABLE IF EXISTS kept_text_log')
  storage.kv.delete(DATA_KEY)
  storage.kv.delete(LOG_KEY)
}
