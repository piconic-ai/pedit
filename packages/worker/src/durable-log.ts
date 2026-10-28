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
export class LogFrozenError extends Error {}
export class StaleCheckpointError extends Error {}

export type Checkpoint = {
  epoch: string
  generation: number
  cutoff: number
  ciphertext: ArrayBuffer
}

export type LogCut = {
  epoch: string
  generation: number
  cutoff: number
  token: string
}

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
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS durable_checkpoint (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      epoch TEXT NOT NULL,
      generation INTEGER NOT NULL,
      cutoff INTEGER NOT NULL,
      ciphertext BLOB NOT NULL,
      token TEXT,
      frozen_cut INTEGER,
      previous_token TEXT,
      previous_epoch TEXT,
      aborted_token TEXT,
      aborted_epoch TEXT,
      aborted_generation INTEGER,
      aborted_cut INTEGER
    )`)
    storage.sql.exec('CREATE TABLE IF NOT EXISTS durable_epochs (epoch TEXT PRIMARY KEY)')
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
      const checkpoint = sql
        .exec<{ epoch: string; token: string | null }>(
          'SELECT epoch, token FROM durable_checkpoint WHERE singleton = 1',
        )
        .toArray()[0]
      if (!checkpoint || checkpoint.epoch !== epoch) {
        throw new StaleCheckpointError('stale epoch')
      }
      if (checkpoint.token) throw new LogFrozenError('durable log is frozen')
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

  checkpoint(): Checkpoint | undefined {
    this.ensureOpen()
    return this.storage.sql
      .exec<Checkpoint>(
        'SELECT epoch, generation, cutoff, ciphertext FROM durable_checkpoint WHERE singleton = 1',
      )
      .toArray()[0]
  }

  pendingCut(): LogCut | undefined {
    this.ensureOpen()
    return this.storage.sql
      .exec<LogCut>(
        'SELECT epoch, generation, frozen_cut AS cutoff, token FROM durable_checkpoint WHERE singleton = 1 AND token IS NOT NULL',
      )
      .toArray()[0]
  }

  beginRead(): Checkpoint & { tail: number } {
    return this.storage.transactionSync(() => {
      this.ensureOpen()
      const current = this.checkpoint()
      if (!current) throw new StaleCheckpointError('checkpoint is missing')
      const tail = this.storage.sql
        .exec<{ tail: number }>('SELECT coalesce(max(sequence), 0) AS tail FROM durable_log')
        .one().tail
      return { ...current, tail: Math.max(current.cutoff, tail) }
    })
  }

  readPage(
    epoch: string,
    generation: number,
    after: number,
    through: number,
    limit: number,
  ): LogEntry[] {
    return this.storage.transactionSync(() => {
      this.ensureOpen()
      const current = this.checkpoint()
      if (
        !current ||
        current.epoch !== epoch ||
        current.generation !== generation ||
        !Number.isSafeInteger(after) ||
        after < current.cutoff ||
        !Number.isSafeInteger(through) ||
        through < after
      ) {
        throw new StaleCheckpointError('stale checkpoint')
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 16)
        throw new Error('invalid durable log range')
      return this.storage.sql
        .exec<LogEntry>(
          'SELECT sequence, ciphertext FROM durable_log WHERE epoch = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?',
          epoch,
          after,
          through,
          limit,
        )
        .toArray()
    })
  }

  private ensureOpen(): void {
    if (
      this.storage.kv.get(ADMISSION_KEY) === undefined ||
      this.storage.sql.exec<{ closed: number }>('SELECT closed FROM durable_log_meta').one().closed
    ) {
      throw new LogClosedError('durable log is closed')
    }
  }

  async initialize(epoch: string, ciphertext: ArrayBuffer): Promise<void> {
    if (
      !epoch ||
      epoch.length > 128 ||
      ciphertext.byteLength === 0 ||
      ciphertext.byteLength > MAX_FRAME_BYTES
    ) {
      throw new Error('invalid checkpoint')
    }
    ciphertext = ciphertext.slice(0)
    this.storage.transactionSync(() => {
      this.ensureOpen()
      const current = this.storage.sql
        .exec<{ epoch: string; generation: number; same: number }>(
          'SELECT epoch, generation, ciphertext = ? AS same FROM durable_checkpoint WHERE singleton = 1',
          ciphertext,
        )
        .toArray()[0]
      if (current?.epoch === epoch && current.generation === 1 && current.same === 1) return
      if (
        current ||
        this.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM durable_log').one()
          .count
      ) {
        throw new StaleCheckpointError('checkpoint already initialized')
      }
      this.storage.sql.exec('INSERT INTO durable_epochs (epoch) VALUES (?)', epoch)
      this.storage.sql.exec(
        'INSERT INTO durable_checkpoint (singleton, epoch, generation, cutoff, ciphertext) VALUES (1, ?, 1, 0, ?)',
        epoch,
        ciphertext,
      )
    })
    await this.storage.sync()
    this.ensureOpen()
    const current = this.storage.sql
      .exec<{ epoch: string; generation: number; same: number }>(
        'SELECT epoch, generation, ciphertext = ? AS same FROM durable_checkpoint WHERE singleton = 1',
        ciphertext,
      )
      .toArray()[0]
    if (!current || current.epoch !== epoch || current.generation !== 1 || current.same !== 1) {
      throw new StaleCheckpointError('checkpoint changed')
    }
  }

  async freeze(epoch: string, generation: number): Promise<LogCut> {
    const token = crypto.randomUUID()
    const cutoff = this.storage.transactionSync(() => {
      this.ensureOpen()
      const current = this.storage.sql
        .exec<{ epoch: string; generation: number; cutoff: number; token: string | null }>(
          'SELECT epoch, generation, cutoff, token FROM durable_checkpoint WHERE singleton = 1',
        )
        .toArray()[0]
      if (!current || current.epoch !== epoch || current.generation !== generation)
        throw new StaleCheckpointError('stale checkpoint')
      if (current.token) throw new LogFrozenError('durable log is frozen')
      const tail = this.storage.sql
        .exec<{ tail: number }>('SELECT coalesce(max(sequence), 0) AS tail FROM durable_log')
        .one().tail
      const cutoff = Math.max(tail, current.cutoff)
      this.storage.sql.exec(
        'UPDATE durable_checkpoint SET token = ?, frozen_cut = ? WHERE singleton = 1',
        token,
        cutoff,
      )
      return cutoff
    })
    await this.storage.sync()
    this.ensureOpen()
    const frozen = this.storage.sql
      .exec<{ token: string | null }>('SELECT token FROM durable_checkpoint WHERE singleton = 1')
      .toArray()[0]
    if (frozen?.token !== token) throw new StaleCheckpointError('stale checkpoint cut')
    return { epoch, generation, cutoff, token }
  }

  async commit(cut: LogCut, nextEpoch: string, ciphertext: ArrayBuffer): Promise<void> {
    if (
      !nextEpoch ||
      nextEpoch.length > 128 ||
      nextEpoch === cut.epoch ||
      ciphertext.byteLength === 0 ||
      ciphertext.byteLength > MAX_FRAME_BYTES
    ) {
      throw new Error('invalid checkpoint')
    }
    ciphertext = ciphertext.slice(0)
    this.storage.transactionSync(() => {
      this.ensureOpen()
      const current = this.storage.sql
        .exec<{
          epoch: string
          generation: number
          cutoff: number
          token: string | null
          frozen_cut: number | null
          previous_token: string | null
          previous_epoch: string | null
          same: number
        }>(
          'SELECT epoch, generation, cutoff, token, frozen_cut, previous_token, previous_epoch, ciphertext = ? AS same FROM durable_checkpoint WHERE singleton = 1',
          ciphertext,
        )
        .toArray()[0]
      if (
        current &&
        current.previous_token === cut.token &&
        current.previous_epoch === cut.epoch &&
        current.generation === cut.generation + 1 &&
        current.cutoff === cut.cutoff &&
        current.epoch === nextEpoch &&
        current.same === 1
      )
        return
      if (
        !current ||
        current.epoch !== cut.epoch ||
        current.generation !== cut.generation ||
        current.token !== cut.token ||
        current.frozen_cut !== cut.cutoff
      ) {
        throw new StaleCheckpointError('stale checkpoint cut')
      }
      if (
        this.storage.sql
          .exec('SELECT epoch FROM durable_epochs WHERE epoch = ?', nextEpoch)
          .toArray().length
      ) {
        throw new StaleCheckpointError('epoch already used')
      }
      if (
        this.storage.sql
          .exec<{ count: number }>('SELECT count(*) AS count FROM durable_epochs')
          .one().count >= 65536
      ) {
        throw new LogFullError('too many checkpoint epochs')
      }
      const tail = this.storage.sql
        .exec<{ tail: number }>('SELECT coalesce(max(sequence), 0) AS tail FROM durable_log')
        .one().tail
      if (tail > cut.cutoff) throw new StaleCheckpointError('checkpoint cut does not cover log')
      this.storage.sql.exec('INSERT INTO durable_epochs (epoch) VALUES (?)', nextEpoch)
      this.storage.sql.exec('DELETE FROM durable_log WHERE sequence <= ?', cut.cutoff)
      this.storage.sql.exec(
        'UPDATE durable_checkpoint SET previous_token = token, previous_epoch = epoch, epoch = ?, generation = generation + 1, cutoff = ?, ciphertext = ?, token = NULL, frozen_cut = NULL WHERE singleton = 1',
        nextEpoch,
        cut.cutoff,
        ciphertext,
      )
    })
    await this.storage.sync()
    this.ensureOpen()
  }

  async abort(cut: LogCut): Promise<void> {
    this.storage.transactionSync(() => {
      this.ensureOpen()
      const rows = this.storage.sql.exec(
        'UPDATE durable_checkpoint SET aborted_token = token, aborted_epoch = epoch, aborted_generation = generation, aborted_cut = frozen_cut, token = NULL, frozen_cut = NULL WHERE singleton = 1 AND epoch = ? AND generation = ? AND token = ? AND frozen_cut = ?',
        cut.epoch,
        cut.generation,
        cut.token,
        cut.cutoff,
      )
      if (rows.rowsWritten !== 1) {
        const previous = this.storage.sql
          .exec(
            'SELECT singleton FROM durable_checkpoint WHERE singleton = 1 AND aborted_epoch = ? AND aborted_generation = ? AND aborted_token = ? AND aborted_cut = ?',
            cut.epoch,
            cut.generation,
            cut.token,
            cut.cutoff,
          )
          .toArray()
        if (!previous.length) throw new StaleCheckpointError('stale checkpoint cut')
      }
    })
    await this.storage.sync()
    this.ensureOpen()
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
        if (
          storage.sql
            .exec(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_checkpoint'",
            )
            .toArray().length
        ) {
          storage.sql.exec('DELETE FROM durable_checkpoint')
        }
        if (
          storage.sql
            .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_epochs'")
            .toArray().length
        ) {
          storage.sql.exec('DELETE FROM durable_epochs')
        }
        storage.sql.exec('UPDATE durable_log_meta SET closed = 1')
      })
    }
  }
}
