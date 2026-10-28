import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import access from '../../testdata/kept-access-vectors.json'
import { decrypt, encrypt } from '../src/cipher.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { KeptOutbox } from '../src/kept-outbox.ts'
import { openKeptRecord } from '../src/kept-record.ts'

const room = 'AAECAwQFBgcICQoLDA0ODw'
const context = () => ({ roomId: room, epoch: new Uint8Array(32).fill(3), generation: 1 })
const edit = parseKeptFragment(access.edit)!
const reader = parseKeptFragment(access.read)!
const commenter = parseKeptFragment(access.comment)!
const dbName = () => `pedit-test-${crypto.randomUUID()}`

async function mutate(
  name: string,
  sender: string,
  sequence: number,
  change: (row: Record<string, unknown>) => Record<string, unknown>,
) {
  const opened = indexedDB.open(name)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    opened.onsuccess = () => resolve(opened.result)
    opened.onerror = () => reject(opened.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('operations', 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    const store = tx.objectStore('operations')
    const get = store.get([sender, sequence])
    get.onsuccess = () => store.put(change(get.result))
  })
  db.close()
}

describe('kept outbox', () => {
  it('rejects selective removal of the prepared state after reopening', async () => {
    const name = dbName()
    const outbox = await KeptOutbox.open(name)
    const sender = await outbox.createSender(edit, room)
    await outbox.enqueue(edit, room, sender, Uint8Array.of(1))
    const original = await outbox.prepare(edit, context(), sender, 1)
    outbox.close()
    await mutate(name, sender, 1, (row) => ({
      ...row,
      epoch: null,
      generation: null,
      ciphertext: null,
    }))
    const reopened = await KeptOutbox.open(name)
    await expect(
      reopened.prepare(edit, { ...context(), generation: 2 }, sender, 1),
    ).rejects.toThrow()
    await expect(reopened.operations(edit, room, sender)).rejects.toThrow()
    await expect(reopened.acknowledge(edit, room, original)).rejects.toThrow()
    reopened.close()
  })

  it('rejects reader re-encryption of a prepared frame', async () => {
    const name = dbName()
    const outbox = await KeptOutbox.open(name)
    const sender = await outbox.createSender(edit, room)
    await outbox.enqueue(edit, room, sender, Uint8Array.of(1))
    const original = await outbox.prepare(edit, context(), sender, 1)
    const keys = await deriveKeptRoomKeys(reader, room)
    const replacement = await encrypt(
      keys.frameKey,
      await decrypt(keys.frameKey, original.ciphertext),
    )
    await mutate(name, sender, 1, (row) => ({ ...row, ciphertext: replacement }))
    await expect(outbox.prepare(edit, context(), sender, 1)).rejects.toThrow()
    await expect(outbox.acknowledge(edit, room, original)).rejects.toThrow()
    outbox.close()
  })

  it('rejects older rows without a prepared-state binding', async () => {
    const name = dbName()
    const outbox = await KeptOutbox.open(name)
    const sender = await outbox.createSender(edit, room)
    await outbox.enqueue(edit, room, sender, Uint8Array.of(1))
    await mutate(name, sender, 1, (row) => {
      delete row.binding
      return row
    })
    await expect(outbox.prepare(edit, context(), sender, 1)).rejects.toThrow()
    await expect(outbox.operations(edit, room, sender)).rejects.toThrow()
    outbox.close()
  })

  it('closes an existing outbox connection when another tab upgrades', async () => {
    const name = dbName()
    const outbox = await KeptOutbox.open(name)
    const upgrade = indexedDB.open(name, 3)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      upgrade.onsuccess = () => resolve(upgrade.result)
      upgrade.onerror = () => reject(upgrade.error)
      upgrade.onblocked = () => reject(new Error('upgrade blocked'))
    })
    await expect(outbox.createSender(edit, room)).rejects.toThrow()
    db.close()
  })

  it('rejects a blocked upgrade and aborts it if the old connection later closes', async () => {
    const name = dbName()
    const old = indexedDB.open(name, 1)
    old.onupgradeneeded = () => {
      old.result.createObjectStore('senders', { keyPath: 'id' })
      old.result.createObjectStore('operations', { keyPath: ['sender', 'sequence'] })
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      old.onsuccess = () => resolve(old.result)
      old.onerror = () => reject(old.error)
    })
    await expect(KeptOutbox.open(name)).rejects.toThrow('upgrade blocked')
    db.close()
    const inspection = indexedDB.open(name)
    const inspected = await new Promise<IDBDatabase>((resolve, reject) => {
      inspection.onsuccess = () => resolve(inspection.result)
      inspection.onerror = () => reject(inspection.error)
    })
    expect(inspected.version).toBe(1)
    inspected.close()
    const reopened = await KeptOutbox.open(name)
    reopened.close()
  })

  it('persists unique sequence, stable ciphertext and an authenticated ACK across database reopen', async () => {
    const name = dbName()
    const a = await KeptOutbox.open(name)
    const b = await KeptOutbox.open(name)
    const sender = await a.createSender(edit, room)
    const sequences = await Promise.all([
      a.enqueue(edit, room, sender, Uint8Array.of(1)),
      b.enqueue(edit, room, sender, Uint8Array.of(2)),
    ])
    expect(sequences.sort()).toEqual([1, 2])
    const [one, other] = await Promise.all([
      a.prepare(edit, context(), sender, 1),
      b.prepare(edit, context(), sender, 1),
    ])
    expect(one.ciphertext).toEqual(other.ciphertext)
    await expect(
      a.acknowledge(edit, room, { ...one, ciphertext: Uint8Array.of(1) }),
    ).rejects.toThrow()
    await a.acknowledge(edit, room, one)
    a.close()
    b.close()
    const reopened = await KeptOutbox.open(name)
    expect(await reopened.senders(edit, room)).toContain(sender)
    const restored = await reopened.prepare(edit, context(), sender, 1)
    expect(restored.acknowledged).toBe(true)
    expect(restored.ciphertext).toEqual(one.ciphertext)
    expect((await reopened.operations(edit, room, sender)).map((op) => op.sequence)).toEqual([1, 2])
    reopened.close()
  })

  it('rejects lower tiers, swapped operation bodies and forged ACKs', async () => {
    const name = dbName()
    const outbox = await KeptOutbox.open(name)
    const sender = await outbox.createSender(edit, room)
    await outbox.enqueue(edit, room, sender, Uint8Array.of(1))
    await outbox.enqueue(edit, room, sender, Uint8Array.of(2))
    await expect(outbox.prepare(reader, context(), sender, 1)).rejects.toThrow()
    await expect(outbox.prepare(commenter, context(), sender, 1)).rejects.toThrow()
    const readerKeys = await deriveKeptRoomKeys(reader, room)
    const opened = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result)
      opened.onerror = () => reject(opened.error)
    })
    const row = await new Promise<{ seed: Uint8Array }>((resolve, reject) => {
      const r = db.transaction('senders').objectStore('senders').get(sender)
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    db.close()
    await expect(decrypt(readerKeys.frameKey, row.seed)).rejects.toThrow()
    let first: unknown, second: unknown
    await mutate(name, sender, 1, (r) => {
      first = r.body
      return r
    })
    await mutate(name, sender, 2, (r) => {
      second = r.body
      return r
    })
    await mutate(name, sender, 1, (r) => ({ ...r, body: second }))
    await expect(outbox.prepare(edit, context(), sender, 1)).rejects.toThrow()
    await mutate(name, sender, 1, (r) => ({ ...r, body: first }))
    const op = await outbox.prepare(edit, context(), sender, 1)
    expect((await openKeptRecord(readerKeys, context(), op.ciphertext)).message).toEqual(
      Uint8Array.of(1),
    )
    await mutate(name, sender, 1, (r) => ({ ...r, ack: Uint8Array.of(3) }))
    await expect(outbox.prepare(edit, context(), sender, 1)).rejects.toThrow()
    outbox.close()
  })

  it('keeps an operation pending on a different epoch or unavailable storage', async () => {
    const outbox = await KeptOutbox.open(dbName())
    const sender = await outbox.createSender(edit, room)
    await outbox.enqueue(edit, room, sender, Uint8Array.of(1))
    await outbox.prepare(edit, context(), sender, 1)
    await expect(
      outbox.prepare(
        edit,
        { ...context(), epoch: new Uint8Array(32).fill(4), generation: 2 },
        sender,
        1,
      ),
    ).rejects.toThrow('outbox epoch changed')
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    try {
      await expect(outbox.enqueue(edit, room, sender, Uint8Array.of(2))).rejects.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(await outbox.enqueue(edit, room, sender, Uint8Array.of(2))).toBe(2)
    outbox.close()
  })
})

it('invalid ack must not bind an unprepared operation to an attacker chosen epoch', async () => {
  const outbox = await KeptOutbox.open(dbName())
  const sender = await outbox.createSender(edit, room)
  const sequence = await outbox.enqueue(edit, room, sender, Uint8Array.of(1))
  const bad = {
    sender,
    sequence,
    epoch: '04'.repeat(32),
    generation: 2,
    ciphertext: Uint8Array.of(9),
    acknowledged: false,
  }
  await expect(outbox.acknowledge(edit, room, bad)).rejects.toThrow()
  await expect(outbox.prepare(edit, context(), sender, sequence)).resolves.toBeDefined()
  outbox.close()
})

it('must detect a deleted pending operation', async () => {
  const name = dbName()
  const outbox = await KeptOutbox.open(name)
  const sender = await outbox.createSender(edit, room)
  await outbox.enqueue(edit, room, sender, Uint8Array.of(42))
  const open = indexedDB.open(name)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('operations', 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    tx.objectStore('operations').delete([sender, 1])
  })
  db.close()
  await expect(outbox.operations(edit, room, sender)).rejects.toThrow()
  await expect(outbox.enqueue(edit, room, sender, Uint8Array.of(43))).rejects.toThrow()
  outbox.close()
})

it('bounds retained senders, operations and operation size without deleting them', async () => {
  const name = dbName()
  const outbox = await KeptOutbox.open(name)
  const sender = await outbox.createSender(edit, room)
  await expect(outbox.enqueue(edit, room, sender, new Uint8Array(64 * 1024 + 1))).rejects.toThrow()
  for (let i = 0; i < 1024; i++) {
    expect(await outbox.enqueue(edit, room, sender, Uint8Array.of(1))).toBe(i + 1)
  }
  await expect(outbox.enqueue(edit, room, sender, Uint8Array.of(2))).rejects.toThrow()
  expect(await outbox.operations(edit, room, sender)).toHaveLength(1024)
  const large = await outbox.createSender(edit, room)
  expect(await outbox.enqueue(edit, room, large, new Uint8Array(64 * 1024))).toBe(1)
  for (let i = 2; i < 63; i++) await outbox.createSender(edit, room)
  const attempts = await Promise.allSettled([
    outbox.createSender(edit, room),
    outbox.createSender(edit, room),
  ])
  expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
  expect(await outbox.senders(edit, room)).toHaveLength(64)
  outbox.close()
}, 30000)

it('rejects a missing sequence hidden by an out-of-range row', async () => {
  for (const extra of [0, 100, 'unexpected', [1]]) {
    const name = dbName()
    const outbox = await KeptOutbox.open(name)
    const sender = await outbox.createSender(edit, room)
    await outbox.enqueue(edit, room, sender, Uint8Array.of(1))
    await outbox.enqueue(edit, room, sender, Uint8Array.of(2))
    const opening = indexedDB.open(name)
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      opening.onsuccess = () => resolve(opening.result)
      opening.onerror = () => reject(opening.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
      const store = tx.objectStore('operations')
      const get = store.get([sender, 2])
      get.onsuccess = () => {
        store.delete([sender, 1])
        store.add({ ...get.result, sequence: extra })
      }
    })
    db.close()
    await expect(outbox.enqueue(edit, room, sender, Uint8Array.of(3))).rejects.toThrow()
    await expect(outbox.operations(edit, room, sender)).rejects.toThrow()
    outbox.close()
  }
})

it('reads a consistent snapshot while another connection enqueues', async () => {
  const name = dbName()
  const a = await KeptOutbox.open(name)
  const b = await KeptOutbox.open(name)
  const sender = await a.createSender(edit, room)
  for (let i = 1; i <= 30; i++) {
    const [sequence, snapshot] = await Promise.all([
      a.enqueue(edit, room, sender, Uint8Array.of(i)),
      b.operations(edit, room, sender),
    ])
    expect(sequence).toBe(i)
    expect(snapshot.length === i || snapshot.length === i - 1).toBe(true)
  }
  expect(await b.operations(edit, room, sender)).toHaveLength(30)
  a.close()
  b.close()
})

it('upgrades an existing v1 outbox before accepting operations', async () => {
  const name = dbName()
  const opening = indexedDB.open(name, 1)
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('senders', { keyPath: 'id' })
    opening.result.createObjectStore('operations', { keyPath: ['sender', 'sequence'] })
  }
  const old = await new Promise<IDBDatabase>((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
  old.close()
  const outbox = await KeptOutbox.open(name)
  const sender = await outbox.createSender(edit, room)
  expect(await outbox.enqueue(edit, room, sender, Uint8Array.of(1))).toBe(1)
  expect(await outbox.operations(edit, room, sender)).toHaveLength(1)
  outbox.close()
})
