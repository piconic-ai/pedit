const ROOM_ID = /^[0-9a-f]{64}$/

// One instance owns one fixed shard. The caller must use the same shard for a
// room forever and durably register it before permitting any R2 PUT.
export class KeptSweepRegistry {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly capacity: number,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000)
      throw new Error('invalid registry capacity')
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS kept_sweep_rooms (id TEXT PRIMARY KEY, generation INTEGER NOT NULL)',
    )
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS kept_sweep_serial (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation INTEGER NOT NULL)',
    )
    storage.sql.exec('INSERT OR IGNORE INTO kept_sweep_serial VALUES (1, 0)')
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS kept_sweep_cursor (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL)',
    )
    storage.sql.exec("INSERT OR IGNORE INTO kept_sweep_cursor VALUES (1, '')")
  }

  async register(id: string): Promise<void> {
    if (!ROOM_ID.test(id)) throw new Error('invalid room id')
    this.storage.transactionSync(() => {
      const count = this.storage.sql
        .exec<{ n: number }>('SELECT count(*) AS n FROM kept_sweep_rooms')
        .one().n
      const existing = this.storage.sql
        .exec('SELECT id FROM kept_sweep_rooms WHERE id = ?', id)
        .toArray().length
      if (!existing && count >= this.capacity) throw new Error('registry capacity reached')
      const generation = this.storage.sql
        .exec<{ generation: number }>(
          'UPDATE kept_sweep_serial SET generation = generation + 1 WHERE singleton = 1 RETURNING generation',
        )
        .one().generation
      if (!Number.isSafeInteger(generation)) throw new Error('registry generation exhausted')
      this.storage.sql.exec(
        'INSERT INTO kept_sweep_rooms VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET generation = excluded.generation',
        id,
        generation,
      )
    })
    await this.storage.sync()
  }

  // Advancing before delivery can delay a failed attempt until the next cycle;
  // it cannot remove the room. Callers must continue polling every shard.
  async next(): Promise<{ id: string; generation: number } | null> {
    const selected = this.storage.transactionSync(() => {
      const cursor = this.storage.sql
        .exec<{ id: string }>('SELECT id FROM kept_sweep_cursor WHERE singleton = 1')
        .one().id
      const row =
        this.storage.sql
          .exec<{ id: string; generation: number }>(
            'SELECT id, generation FROM kept_sweep_rooms WHERE id > ? ORDER BY id LIMIT 1',
            cursor,
          )
          .toArray()[0] ??
        this.storage.sql
          .exec<{ id: string; generation: number }>(
            'SELECT id, generation FROM kept_sweep_rooms ORDER BY id LIMIT 1',
          )
          .toArray()[0]
      if (!row) return null
      this.storage.sql.exec('UPDATE kept_sweep_cursor SET id = ? WHERE singleton = 1', row.id)
      return row
    })
    await this.storage.sync()
    return selected
  }

  async retire(id: string, generation: number): Promise<void> {
    if (!ROOM_ID.test(id) || !Number.isSafeInteger(generation) || generation < 1)
      throw new Error('invalid registry retirement')
    this.storage.sql.exec(
      'DELETE FROM kept_sweep_rooms WHERE id = ? AND generation = ?',
      id,
      generation,
    )
    await this.storage.sync()
  }
}
