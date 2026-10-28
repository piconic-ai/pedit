import access from '../../testdata/kept-access-vectors.json'
import { decrypt, encrypt } from '../src/cipher.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { KeptOutbox } from '../src/kept-outbox.ts'
import { openKeptRecord } from '../src/kept-record.ts'

async function run() {
  const link = parseKeptFragment(access.edit)
  if (!link) throw new Error('bad fixture')
  const keys = await deriveKeptRoomKeys(link, 'AAECAwQFBgcICQoLDA0ODw')
  const name = `pedit-outbox-test-${crypto.randomUUID()}`
  let a = await KeptOutbox.open(name)
  let b = await KeptOutbox.open(name)
  const sender = await a.createSender(link, keys.roomId)
  const reader = parseKeptFragment(access.read)
  const commenter = parseKeptFragment(access.comment)
  if (!reader || !commenter) throw new Error('invalid fixture')
  for (const wrong of [reader, commenter]) {
    let denied = false
    try {
      await b.enqueue(wrong, keys.roomId, sender, Uint8Array.of(9))
    } catch {
      denied = true
    }
    if (!denied) throw new Error('lower tier queued as editor')
  }
  const seq = await Promise.all([
    a.enqueue(link, keys.roomId, sender, Uint8Array.of(1)),
    b.enqueue(link, keys.roomId, sender, Uint8Array.of(2)),
  ])
  if (seq.slice().sort().join() !== '1,2') throw new Error('sequence collision')
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (value, key) {
    if (this.name === 'operations') throw new DOMException('injected quota', 'QuotaExceededError')
    return add.call(this, value, key)
  }
  let aborted = false
  try {
    await a.enqueue(link, keys.roomId, sender, Uint8Array.of(3))
  } catch {
    aborted = true
  } finally {
    IDBObjectStore.prototype.add = add
  }
  if (!aborted) throw new Error('quota failure accepted')
  if ((await a.enqueue(link, keys.roomId, sender, Uint8Array.of(3))) !== 3)
    throw new Error('aborted transaction consumed sequence')
  const c = { roomId: keys.roomId, epoch: new Uint8Array(32).fill(3), generation: 1 }
  const readKeys = await deriveKeptRoomKeys(reader, keys.roomId)
  const inspection = indexedDB.open(name)
  const idb = await new Promise<IDBDatabase>((resolve, reject) => {
    inspection.onsuccess = () => resolve(inspection.result)
    inspection.onerror = () => reject(inspection.error)
  })
  const senderRow = await new Promise<{ seed: Uint8Array }>((resolve, reject) => {
    const get = idb.transaction('senders').objectStore('senders').get(sender)
    get.onsuccess = () => resolve(get.result)
    get.onerror = () => reject(get.error)
  })
  idb.close()
  let seedProtected = false
  try {
    await decrypt(readKeys.frameKey, senderRow.seed)
  } catch {
    seedProtected = true
  }
  if (!seedProtected) throw new Error('read link unwrapped editor seed')
  const swapBodies = async () => {
    const opened = indexedDB.open(name)
    const rawDb = await new Promise<IDBDatabase>((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result)
      opened.onerror = () => reject(opened.error)
    })
    await new Promise<void>((resolve, reject) => {
      const tx = rawDb.transaction('operations', 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
      const store = tx.objectStore('operations')
      const one = store.get([sender, 1])
      const two = store.get([sender, 2])
      two.onsuccess = () => {
        const first = one.result
        const second = two.result
        store.put({ ...first, body: second.body })
        store.put({ ...second, body: first.body })
      }
    })
    rawDb.close()
  }
  await swapBodies()
  let rejectedSwap = false
  try {
    await a.prepare(link, c, sender, 1)
  } catch {
    rejectedSwap = true
  }
  if (!rejectedSwap) throw new Error('accepted swapped message')
  await swapBodies()
  const [one, two] = await Promise.all([
    a.prepare(link, c, sender, 1),
    b.prepare(link, c, sender, 1),
  ])
  for (const wrong of [reader, commenter]) {
    let denied = false
    try {
      await b.prepare(wrong, c, sender, 1)
    } catch {
      denied = true
    }
    if (!denied) throw new Error('lower tier signed as editor')
  }
  let epochRejected = false
  try {
    await b.prepare(link, { ...c, epoch: new Uint8Array(32).fill(4), generation: 2 }, sender, 1)
  } catch {
    epochRejected = true
  }
  if (!epochRejected) throw new Error('accepted unverified epoch change')
  const checked = await openKeptRecord(readKeys, c, one.ciphertext)
  if (checked.message[0] !== 1) throw new Error('wrong signed message')
  if (one.ciphertext.toString() !== two.ciphertext.toString())
    throw new Error('retry ciphertext changed')
  const alter = async (change: (row: Record<string, unknown>) => Record<string, unknown>) => {
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
      const get = store.get([sender, 1])
      get.onsuccess = () => store.put(change(get.result))
    })
    db.close()
  }
  await alter((row) => ({ ...row, epoch: null, generation: null, ciphertext: null }))
  let rejectedClearing = false
  try {
    await a.prepare(link, { ...c, generation: 2 }, sender, 1)
  } catch {
    rejectedClearing = true
  }
  if (!rejectedClearing) throw new Error('accepted cleared prepared state')
  await alter((row) => ({
    ...row,
    epoch: one.epoch,
    generation: one.generation,
    ciphertext: one.ciphertext,
  }))
  const replacement = await encrypt(
    readKeys.frameKey,
    await decrypt(readKeys.frameKey, one.ciphertext),
  )
  await alter((row) => ({ ...row, ciphertext: replacement }))
  let rejectedReplacement = false
  try {
    await b.prepare(link, c, sender, 1)
  } catch {
    rejectedReplacement = true
  }
  if (!rejectedReplacement) throw new Error('accepted re-encrypted prepared state')
  await alter((row) => ({ ...row, ciphertext: one.ciphertext }))
  const o = indexedDB.open(name)
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    o.onsuccess = () => resolve(o.result)
    o.onerror = () => reject(o.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('operations', 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    const store = tx.objectStore('operations')
    const get = store.get([sender, 1])
    get.onsuccess = () => store.put({ ...get.result, ack: Uint8Array.of(3) })
  })
  db.close()
  let forgedAckRejected = false
  try {
    await a.prepare(link, c, sender, 1)
  } catch {
    forgedAckRejected = true
  }
  if (!forgedAckRejected) throw new Error('accepted forged acknowledgement')
  const restore = indexedDB.open(name)
  const restoreDb = await new Promise<IDBDatabase>((resolve, reject) => {
    restore.onsuccess = () => resolve(restore.result)
    restore.onerror = () => reject(restore.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = restoreDb.transaction('operations', 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    const store = tx.objectStore('operations')
    const get = store.get([sender, 1])
    get.onsuccess = () => store.put({ ...get.result, ack: null })
  })
  restoreDb.close()
  let rejected = false
  try {
    await a.acknowledge(link, keys.roomId, { ...one, ciphertext: Uint8Array.of(3) })
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('accepted invalid acknowledgement')
  await a.acknowledge(link, keys.roomId, one)
  a.close()
  b.close()
  a = await KeptOutbox.open(name)
  b = await KeptOutbox.open(name)
  const resumed = await a.prepare(link, c, sender, 1)
  const ops = await b.operations(link, keys.roomId, sender)
  if (
    !resumed.acknowledged ||
    resumed.ciphertext.toString() !== one.ciphertext.toString() ||
    ops.length !== 3
  )
    throw new Error('reload lost state')
  const list = await b.senders(link, keys.roomId)
  if (!list.includes(sender)) throw new Error('sender lost')
  a.close()
  b.close()
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name)
    r.onsuccess = () => resolve()
    r.onerror = () => reject(r.error)
  })
  return 'PASS: tier isolation, body binding, atomic sequence, ACK integrity, retry and reopen'
}
run()
  .then((result) => {
    document.querySelector('#result')!.textContent = result
  })
  .catch((error: unknown) => {
    document.querySelector('#result')!.textContent = `FAIL: ${String(error)}`
  })
