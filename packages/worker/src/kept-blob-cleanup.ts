const RETRY_MS = 60_000
const MAX_BATCHES = 16
const BLOB_ID = /^[A-Za-z0-9_-]{22}$/

type PutRow = { id: string; completed: number }
export type KeptBlobLimits = { count: number; blobBytes: number; quotaBytes: number }

export class KeptBlobCleanup {
  private readonly prefix: string
  private readonly storage: DurableObjectStorage
  constructor(
    state: DurableObjectState,
    private readonly bucket: R2Bucket,
    private readonly limits: KeptBlobLimits,
  ) {
    if (
      !Number.isSafeInteger(limits.count) ||
      limits.count < 1 ||
      limits.count > 1024 ||
      !Number.isSafeInteger(limits.blobBytes) ||
      limits.blobBytes < 1 ||
      limits.blobBytes > 10 * 1024 * 1024 ||
      !Number.isSafeInteger(limits.quotaBytes) ||
      limits.quotaBytes < 1 ||
      limits.quotaBytes > 100 * 1024 * 1024
    )
      throw new Error('invalid kept blob limits')
    this.storage = state.storage
    this.prefix = `kept/${state.id.toString()}/`
    const storage = this.storage
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS kept_blob_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), closed INTEGER NOT NULL)`,
    )
    storage.sql.exec('INSERT OR IGNORE INTO kept_blob_state (singleton, closed) VALUES (1, 0)')
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS kept_blob_puts (id TEXT PRIMARY KEY, completed INTEGER NOT NULL, bytes INTEGER NOT NULL)`,
    )
  }

  private closed(): boolean {
    return (
      this.storage.sql
        .exec<{ closed: number }>('SELECT closed FROM kept_blob_state WHERE singleton = 1')
        .one().closed !== 0
    )
  }

  async put(id: string, content: Uint8Array): Promise<void> {
    if (!BLOB_ID.test(id) || content.length === 0 || content.length > this.limits.blobBytes)
      throw new Error('invalid kept blob')
    const data = Uint8Array.from(content)
    this.storage.transactionSync(() => {
      if (this.closed()) throw new Error('kept room is closed')
      const usage = this.storage.sql
        .exec<{ count: number; bytes: number }>(
          'SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM kept_blob_puts',
        )
        .one()
      if (usage.count >= this.limits.count || usage.bytes + data.length > this.limits.quotaBytes)
        throw new Error('kept blob capacity reached')
      this.storage.sql.exec(
        'INSERT INTO kept_blob_puts (id, completed, bytes) VALUES (?, 0, ?)',
        id,
        data.length,
      )
    })
    await this.storage.sync()
    if (this.closed()) {
      this.storage.sql.exec('DELETE FROM kept_blob_puts WHERE id = ?', id)
      await this.storage.sync()
      throw new Error('kept room is closed')
    }
    await this.bucket.put(this.prefix + id, data)
    this.storage.sql.exec('UPDATE kept_blob_puts SET completed = 1 WHERE id = ?', id)
    await this.storage.sync()
    if (this.closed()) throw new Error('kept room is closed')
  }

  async close(): Promise<void> {
    await this.storage.transaction(async () => {
      this.storage.sql.exec('UPDATE kept_blob_state SET closed = 1 WHERE singleton = 1')
      await this.arm()
    })
    await this.storage.sync()
  }

  private async arm(): Promise<void> {
    const next = Date.now() + RETRY_MS
    const existing = await this.storage.getAlarm()
    if (existing === null || next < existing) await this.storage.setAlarm(next)
  }

  async sweep(): Promise<boolean> {
    if (!this.closed()) throw new Error('kept room is open')
    await this.storage.transaction(async () => {
      await this.arm()
    })
    await this.storage.sync()
    const finished = this.storage.sql
      .exec<PutRow>('SELECT id, completed FROM kept_blob_puts WHERE completed = 1')
      .toArray()
    let empty = false
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const page = await this.bucket.list({ prefix: this.prefix })
      if (page.objects.length === 0) {
        if (page.truncated) throw new Error('incomplete kept blob listing')
        empty = true
        break
      }
      await this.bucket.delete(page.objects.map((object) => object.key))
    }
    if (!empty) return false
    const complete = this.storage.transactionSync(() => {
      for (const row of finished)
        this.storage.sql.exec('DELETE FROM kept_blob_puts WHERE id = ? AND completed = 1', row.id)
      const count = this.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM kept_blob_puts')
        .one().n
      return count === 0
    })
    await this.storage.sync()
    return complete
  }
}
