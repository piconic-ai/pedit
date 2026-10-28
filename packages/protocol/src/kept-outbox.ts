import { buf, concat, hkdf, signingPair, utf8 } from './access-crypto.ts'
import { decrypt, encrypt } from './cipher.ts'
import { deriveKeptRoomKeys, type KeptLinkSecrets, type KeptRoomKeys } from './kept-access.ts'
import {
  createKeptSenderCertificate,
  type KeptRecordContext,
  MAX_KEPT_RECORD_PAYLOAD,
  openKeptRecord,
  sealKeptRecord,
} from './kept-record.ts'

export const MAX_OUTBOX_SENDERS = 64
export const MAX_OUTBOX_OPERATIONS = 1024
export const MAX_OUTBOX_MESSAGE_BYTES = 64 * 1024

type Sender = {
  id: string
  room: string
  access: 'edit' | 'comment'
  seed: Uint8Array
  certificate: Uint8Array
  sequence: number
  counter: Uint8Array
}
type Operation = {
  sender: string
  sequence: number
  body: Uint8Array
  epoch: string | null
  generation: number | null
  ciphertext: Uint8Array | null
  ack: Uint8Array | null
}
export type PendingOperation = {
  sender: string
  sequence: number
  epoch: string
  generation: number
  ciphertext: Uint8Array
  acknowledged: boolean
}
type Credentials = { keys: KeptRoomKeys; wrap: CryptoKey; access: 'edit' | 'comment' }

async function credentials(link: KeptLinkSecrets, room: string): Promise<Credentials> {
  link = structuredClone(link)
  if (link.access === 'read') throw new Error('outbox requires an edit or comment link')
  const keys = await deriveKeptRoomKeys(link, room)
  const raw = await hkdf(
    link.secret,
    concat(
      utf8.encode('pedit/v6/outbox-wrap\0'),
      utf8.encode(room),
      utf8.encode(link.access),
      keys.frameSecret,
    ),
  )
  const wrap = await crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
  raw.fill(0)
  return { keys, wrap, access: link.access }
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error('outbox transaction aborted'))
    tx.onerror = () => {}
  })
}
function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}
function writable(db: IDBDatabase): IDBTransaction {
  const tx = db.transaction(['senders', 'operations'], 'readwrite', { durability: 'strict' })
  if (tx.durability !== 'strict') {
    tx.abort()
    throw new Error('strict outbox durability unavailable')
  }
  return tx
}
const epochId = (epoch: Uint8Array) =>
  Array.from(epoch, (b) => b.toString(16).padStart(2, '0')).join('')
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((v, i) => v === b[i])
const counterBody = (id: string, sequence: number) => utf8.encode(`${id}:${sequence}`)
const operationBody = (id: string, sequence: number, message: Uint8Array) =>
  concat(counterBody(id, sequence), Uint8Array.of(0), message)
function unpack(id: string, sequence: number, body: Uint8Array): Uint8Array {
  const prefix = concat(counterBody(id, sequence), Uint8Array.of(0))
  if (!same(body.subarray(0, prefix.length), prefix)) throw new Error('invalid outbox operation')
  return body.slice(prefix.length)
}

export class KeptOutbox {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(name = 'pedit-v6-outbox'): Promise<KeptOutbox> {
    const opening = indexedDB.open(name, 1)
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore('senders', { keyPath: 'id' })
      opening.result.createObjectStore('operations', { keyPath: ['sender', 'sequence'] })
    }
    return new KeptOutbox(await request(opening))
  }
  close(): void {
    this.db.close()
  }

  private async checkIdentity(
    auth: Credentials,
    sender: string,
    row: Sender | undefined,
  ): Promise<Sender> {
    if (!row || row.room !== auth.keys.roomId || row.access !== auth.access)
      throw new Error('invalid outbox sender')
    const seed = await decrypt(auth.wrap, row.seed)
    seed.fill(0)
    const counter = await decrypt(auth.wrap, row.counter)
    if (
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 0 ||
      !same(counter, counterBody(sender, row.sequence))
    )
      throw new Error('invalid outbox counter')
    return row
  }

  private async identity(auth: Credentials, sender: string): Promise<Sender> {
    const tx = this.db.transaction('senders', 'readonly')
    const row: Sender | undefined = await request(tx.objectStore('senders').get(sender))
    return this.checkIdentity(auth, sender, row)
  }

  async createSender(link: KeptLinkSecrets, room: string): Promise<string> {
    const auth = await credentials(link, room)
    const seed = crypto.getRandomValues(new Uint8Array(32))
    let wrapped: Uint8Array
    let certificate: Uint8Array
    try {
      const pair = await signingPair(seed)
      certificate = await createKeptSenderCertificate(auth.keys, pair.publicKey)
      wrapped = await encrypt(auth.wrap, seed)
    } finally {
      seed.fill(0)
    }
    const id = crypto.randomUUID()
    const counter = await encrypt(auth.wrap, counterBody(id, 0))
    const tx = writable(this.db)
    const done = transactionDone(tx)
    const store = tx.objectStore('senders')
    const count = store.count()
    count.onsuccess = () => {
      if (count.result >= MAX_OUTBOX_SENDERS) {
        tx.abort()
        return
      }
      store.add({
        id,
        room,
        access: auth.access,
        seed: wrapped,
        certificate,
        sequence: 0,
        counter,
      } satisfies Sender)
    }
    await done
    return id
  }

  async senders(link: KeptLinkSecrets, room: string): Promise<string[]> {
    const auth = await credentials(link, room)
    const tx = this.db.transaction('senders', 'readonly')
    const rows: Sender[] = await request(tx.objectStore('senders').getAll())
    return rows
      .filter((row) => row.room === room && row.access === auth.access)
      .map((row) => row.id)
  }

  async operations(
    link: KeptLinkSecrets,
    room: string,
    sender: string,
  ): Promise<{ sequence: number; message: Uint8Array; acknowledged: boolean }[]> {
    const auth = await credentials(link, room)
    const tx = this.db.transaction(['senders', 'operations'], 'readonly')
    const identity = request<Sender | undefined>(tx.objectStore('senders').get(sender))
    const operations = request<Operation[]>(
      tx
        .objectStore('operations')
        .getAll(IDBKeyRange.bound([sender, 1], [sender, Number.MAX_SAFE_INTEGER])),
    )
    const [row, rows] = await Promise.all([identity, operations])
    const checked = await this.checkIdentity(auth, sender, row)
    if (
      rows.length !== checked.sequence ||
      rows.some((item, i) => item.sender !== sender || item.sequence !== i + 1)
    )
      throw new Error('outbox operations missing')
    return Promise.all(
      rows.map(async (row) => ({
        sequence: row.sequence,
        message: unpack(sender, row.sequence, await decrypt(auth.wrap, row.body)),
        acknowledged: await this.acknowledged(auth, row),
      })),
    )
  }

  async enqueue(
    link: KeptLinkSecrets,
    room: string,
    sender: string,
    message: Uint8Array,
  ): Promise<number> {
    if (
      message.length < 1 ||
      message.length > Math.min(MAX_KEPT_RECORD_PAYLOAD, MAX_OUTBOX_MESSAGE_BYTES)
    )
      throw new Error('invalid outbox message')
    const input = Uint8Array.from(message)
    const auth = await credentials(link, room)
    for (let attempt = 0; attempt < 16; attempt++) {
      const identity = await this.identity(auth, sender)
      if (
        !Number.isSafeInteger(identity.sequence) ||
        identity.sequence < 0 ||
        identity.sequence >= MAX_OUTBOX_OPERATIONS
      )
        throw new Error('invalid outbox counter')
      const sequence = identity.sequence + 1
      const body = await encrypt(auth.wrap, operationBody(sender, sequence, input))
      const counter = await encrypt(auth.wrap, counterBody(sender, sequence))
      const tx = writable(this.db)
      const done = transactionDone(tx)
      let stale = false
      const store = tx.objectStore('senders')
      const get = store.get(sender)
      get.onsuccess = () => {
        const found: Sender | undefined = get.result
        if (
          !found ||
          found.sequence !== identity.sequence ||
          !same(found.counter, identity.counter) ||
          !same(found.seed, identity.seed)
        ) {
          stale = true
          tx.abort()
          return
        }
        const operations = tx.objectStore('operations')
        const count = operations.count(
          IDBKeyRange.bound([sender, 1], [sender, Number.MAX_SAFE_INTEGER]),
        )
        count.onsuccess = () => {
          if (count.result !== identity.sequence) {
            tx.abort()
            return
          }
          store.put({ ...found, sequence, counter })
          operations.add({
            sender,
            sequence,
            body,
            epoch: null,
            generation: null,
            ciphertext: null,
            ack: null,
          } satisfies Operation)
        }
      }
      try {
        await done
        return sequence
      } catch (error) {
        if (!stale) throw error
      }
    }
    throw new Error('outbox is busy')
  }

  async prepare(
    link: KeptLinkSecrets,
    context: KeptRecordContext,
    sender: string,
    sequence: number,
  ): Promise<PendingOperation> {
    const c = { ...context, epoch: Uint8Array.from(context.epoch) }
    const auth = await credentials(link, c.roomId)
    const identity = await this.identity(auth, sender)
    if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > identity.sequence)
      throw new Error('invalid outbox sequence')
    const epoch = epochId(c.epoch)
    const tx = this.db.transaction('operations', 'readonly')
    const op: Operation | undefined = await request(
      tx.objectStore('operations').get([sender, sequence]),
    )
    if (!op) throw new Error('unknown outbox operation')
    if (op.ciphertext) return this.pending(auth, identity, op, c, epoch)
    const message = unpack(sender, sequence, await decrypt(auth.wrap, op.body))
    const seed = await decrypt(auth.wrap, identity.seed)
    let sealed: Uint8Array
    try {
      const pair = await signingPair(seed)
      sealed = await sealKeptRecord(
        auth.keys,
        c,
        pair.sign,
        identity.certificate,
        sequence,
        message,
      )
    } finally {
      seed.fill(0)
    }
    const write = writable(this.db)
    const done = transactionDone(write)
    const store = write.objectStore('operations')
    const existing = store.get([sender, sequence])
    let saved: Operation | undefined
    existing.onsuccess = () => {
      const current: Operation | undefined = existing.result
      if (!current || !same(current.body, op.body)) {
        write.abort()
        return
      }
      if (current.ciphertext) {
        saved = current
        return
      }
      saved = { ...current, epoch, generation: c.generation, ciphertext: sealed }
      store.put(saved)
    }
    await done
    if (!saved) throw new Error('unknown outbox operation')
    return this.pending(auth, identity, saved, c, epoch)
  }

  private async proof(auth: Credentials, op: Operation): Promise<Uint8Array> {
    if (!op.ciphertext || !op.epoch || op.generation === null)
      throw new Error('invalid outbox acknowledgement')
    return new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        buf(
          concat(
            utf8.encode('pedit/v6/outbox-ack\0'),
            counterBody(op.sender, op.sequence),
            utf8.encode(`:${op.epoch}:${op.generation}:`),
            op.ciphertext,
          ),
        ),
      ),
    )
  }

  private async acknowledged(auth: Credentials, op: Operation): Promise<boolean> {
    if (!op.ack) return false
    const proof = await decrypt(auth.wrap, op.ack)
    if (!same(proof, await this.proof(auth, op))) throw new Error('invalid outbox acknowledgement')
    return true
  }

  private async pending(
    auth: Credentials,
    identity: Sender,
    op: Operation,
    context: KeptRecordContext,
    epoch: string,
  ): Promise<PendingOperation> {
    if (!op.ciphertext || op.epoch !== epoch || op.generation !== context.generation)
      throw new Error('outbox epoch changed')
    const plain = unpack(op.sender, op.sequence, await decrypt(auth.wrap, op.body))
    const record = await openKeptRecord(auth.keys, context, op.ciphertext)
    const seed = await decrypt(auth.wrap, identity.seed)
    let publicKey: Uint8Array
    try {
      publicKey = (await signingPair(seed)).publicKey
    } finally {
      seed.fill(0)
    }
    if (
      record.sequence !== op.sequence ||
      !same(record.sender, publicKey) ||
      !same(record.message, plain)
    )
      throw new Error('invalid outbox operation')
    return {
      sender: op.sender,
      sequence: op.sequence,
      epoch,
      generation: context.generation,
      ciphertext: op.ciphertext,
      acknowledged: await this.acknowledged(auth, op),
    }
  }

  async acknowledge(link: KeptLinkSecrets, room: string, item: PendingOperation): Promise<void> {
    const snapshot = { ...item, ciphertext: Uint8Array.from(item.ciphertext) }
    const auth = await credentials(link, room)
    const identity = await this.identity(auth, snapshot.sender)
    const read = this.db.transaction('operations', 'readonly')
    const op: Operation | undefined = await request(
      read.objectStore('operations').get([snapshot.sender, snapshot.sequence]),
    )
    if (!op || !op.ciphertext) throw new Error('invalid outbox acknowledgement')
    const context = {
      roomId: room,
      epoch: Uint8Array.from(snapshot.epoch.match(/../g) ?? [], (v) => Number.parseInt(v, 16)),
      generation: snapshot.generation,
    }
    const current = await this.pending(auth, identity, op, context, epochId(context.epoch))
    if (
      current.epoch !== snapshot.epoch ||
      current.generation !== snapshot.generation ||
      !same(current.ciphertext, snapshot.ciphertext)
    )
      throw new Error('invalid outbox acknowledgement')
    const proof = await this.proof(auth, {
      sender: snapshot.sender,
      sequence: snapshot.sequence,
      epoch: snapshot.epoch,
      generation: snapshot.generation,
      ciphertext: snapshot.ciphertext,
      body: new Uint8Array(),
      ack: null,
    })
    const marker = await encrypt(auth.wrap, proof)
    const tx = writable(this.db)
    const done = transactionDone(tx)
    const store = tx.objectStore('operations')
    const get = store.get([snapshot.sender, snapshot.sequence])
    get.onsuccess = () => {
      const op: Operation | undefined = get.result
      if (
        !op?.ciphertext ||
        op.epoch !== snapshot.epoch ||
        op.generation !== snapshot.generation ||
        !same(op.ciphertext, snapshot.ciphertext)
      ) {
        tx.abort()
        return
      }
      store.put({ ...op, ack: marker })
    }
    await done
  }
}
