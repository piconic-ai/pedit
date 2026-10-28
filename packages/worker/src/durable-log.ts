import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { ADMISSION_KEY } from './room-storage.ts'

export interface LogLimits {
  bytes: number
  frames: number
}

export type LogEntry = {
  sequence: number
  ciphertext: ArrayBuffer
}

export class LogFullError extends Error {}
export class LogClosedError extends Error {}

export class DurableLog {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly limits: LogLimits,
  ) {
    if (storage.kv.get(ADMISSION_KEY) === undefined) {
      throw new LogClosedError('durable log is closed')
    }
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS durable_log (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      epoch TEXT NOT NULL,
      digest BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      UNIQUE(epoch, digest)
    )`)
    storage.sql.exec('CREATE TABLE IF NOT EXISTS durable_log_meta (closed INTEGER NOT NULL)')
    storage.sql.exec(
      'INSERT INTO durable_log_meta (closed) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM durable_log_meta)',
    )
  }

  async append(epoch: string, ciphertext: ArrayBuffer): Promise<number> {
    if (
      !epoch ||
      epoch.length > 128 ||
      ciphertext.byteLength === 0 ||
      ciphertext.byteLength > MAX_FRAME_BYTES
    ) {
      throw new Error('invalid durable frame')
    }
    ciphertext = ciphertext.slice(0)
    const digest = await crypto.subtle.digest('SHA-256', ciphertext)
    const sequence = this.storage.transactionSync(() => {
      const sql = this.storage.sql
      if (
        this.storage.kv.get(ADMISSION_KEY) === undefined ||
        sql.exec<{ closed: number }>('SELECT closed FROM durable_log_meta').one().closed
      ) {
        throw new LogClosedError('durable log is closed')
      }
      const previous = sql
        .exec<{ sequence: number }>(
          'SELECT sequence FROM durable_log WHERE epoch = ? AND digest = ?',
          epoch,
          digest,
        )
        .toArray()[0]
      if (previous) return previous.sequence
      const usage = sql
        .exec<{ frames: number; bytes: number }>(
          'SELECT count(*) AS frames, coalesce(sum(length(ciphertext)), 0) AS bytes FROM durable_log',
        )
        .one()
      if (
        usage.frames >= this.limits.frames ||
        usage.bytes + ciphertext.byteLength > this.limits.bytes
      ) {
        throw new LogFullError('durable log is full')
      }
      return sql
        .exec<{ sequence: number }>(
          'INSERT INTO durable_log (epoch, digest, ciphertext) VALUES (?, ?, ?) RETURNING sequence',
          epoch,
          digest,
          ciphertext,
        )
        .one().sequence
    })
    await this.storage.sync()
    if (
      this.storage.kv.get(ADMISSION_KEY) === undefined ||
      this.storage.sql.exec<{ closed: number }>('SELECT closed FROM durable_log_meta').one().closed
    ) {
      throw new LogClosedError('durable log is closed')
    }
    return sequence
  }

  read(epoch: string, after: number, limit: number): LogEntry[] {
    if (
      !epoch ||
      epoch.length > 128 ||
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 16
    ) {
      throw new Error('invalid durable log range')
    }
    return this.storage.sql
      .exec<LogEntry>(
        'SELECT sequence, ciphertext FROM durable_log WHERE epoch = ? AND sequence > ? ORDER BY sequence LIMIT ?',
        epoch,
        after,
        limit,
      )
      .toArray()
  }

  static clear(storage: DurableObjectStorage): void {
    const exists = storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_log'",
      )
      .toArray()[0]
    if (exists) {
      storage.transactionSync(() => {
        storage.sql.exec('DELETE FROM durable_log')
        storage.sql.exec('UPDATE durable_log_meta SET closed = 1')
      })
    }
  }
}
