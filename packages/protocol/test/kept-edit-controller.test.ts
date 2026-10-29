import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import access from '../../testdata/kept-access-vectors.json'
import { parseKeptFragment } from '../src/kept-access.ts'
import { KeptEditController, type KeptEditStatus } from '../src/kept-edit-controller.ts'
import { KeptOutbox } from '../src/kept-outbox.ts'

const link = parseKeptFragment(access.edit)!
const roomId = 'AAECAwQFBgcICQoLDA0ODw'
const context = { roomId, epoch: new Uint8Array(32).fill(3), generation: 1 }
const until = async (f: () => boolean) => {
  for (let i = 0; i < 1000 && !f(); i++) await new Promise((r) => setTimeout(r, 2))
  if (!f()) throw new Error('timed out')
}
const activeLocks = new Set<string>()
const locks = {
  request: async (
    name: string,
    _options: unknown,
    callback: (lock: object | null) => Promise<void>,
  ) => {
    if (activeLocks.has(name)) return callback(null)
    activeLocks.add(name)
    try {
      await callback({})
    } finally {
      activeLocks.delete(name)
    }
  },
} as unknown as LockManager
async function setup() {
  const name = `review-${crypto.randomUUID()}`
  const outbox = await KeptOutbox.open(name)
  const sender = await outbox.createSender(link, roomId)
  let status: KeptEditStatus = 'idle'
  const opts = {
    url: 'https://example.test',
    link,
    context,
    sender,
    outbox,
    locks,
    baseline: Y.encodeStateAsUpdate(new Y.Doc()),
    onStatus: (x: KeptEditStatus) => {
      status = x
    },
    fetch: async () => {
      throw new Error('offline')
    },
  }
  return { outbox, sender, opts, name, status: () => status }
}
it('close drains all edits and restores them', async () => {
  const { outbox, sender, opts } = await setup()
  const enqueue = outbox.enqueue.bind(outbox)
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  outbox.enqueue = async (...args) => {
    await gate
    return enqueue(...args)
  }
  const c = await KeptEditController.open(opts)
  await c.replace(0, 0, 'one')
  await c.replace(3, 3, 'two')
  const done = c.close()
  release()
  await done
  expect(await outbox.operations(link, roomId, sender)).toHaveLength(2)
  const reopened = await KeptEditController.open(opts)
  expect(reopened.text()).toBe('onetwo')
  await reopened.close()
  outbox.close()
})
it('remote updates are never re-sent and unknown roots are rejected', async () => {
  const { outbox, sender, opts } = await setup()
  const c = await KeptEditController.open(opts)
  const remote = new Y.Doc()
  remote.getText('content').insert(0, 'remote')
  await c.applyRemote(Y.encodeStateAsUpdate(remote))
  expect(c.text()).toBe('remote')
  const wrong = new Y.Doc()
  wrong.getMap('other').set('key', 'value')
  await expect(c.applyRemote(Y.encodeStateAsUpdate(wrong))).rejects.toThrow()
  await c.close()
  expect(await outbox.operations(link, roomId, sender)).toHaveLength(0)
  remote.destroy()
  wrong.destroy()
  outbox.close()
})
it('concurrent senders can report idle while another operation remains pending', async () => {
  const { outbox, sender, opts } = await setup()
  const { KeptOutboxSender } = await import('../src/kept-outbox-sender.ts')
  await outbox.enqueue(link, roomId, sender, Uint8Array.of(1))
  await outbox.enqueue(link, roomId, sender, Uint8Array.of(2))
  const fetch = async () => new Response('{"sequence":1}', { status: 200 })
  const a = new KeptOutboxSender({ ...opts, fetch })
  const b = new KeptOutboxSender({ ...opts, fetch })
  const prepare = outbox.prepare.bind(outbox)
  let first = true
  outbox.prepare = async (...args) => {
    if (first) {
      first = false
      expect((await b.sendNext()).status).toBe('relay-accepted')
    }
    return prepare(...args)
  }
  expect((await a.sendNext()).status).toBe('relay-accepted')
  const rows = await outbox.operations(link, roomId, sender)
  expect(rows.map((r) => r.acknowledged)).toEqual([true, true])
  outbox.close()
})

it('retries identical stored ciphertext after a lost response', async () => {
  const { outbox, sender, opts } = await setup()
  const { KeptOutboxSender } = await import('../src/kept-outbox-sender.ts')
  await outbox.enqueue(link, roomId, sender, Uint8Array.of(1))
  const sent: Uint8Array[] = []
  const send = new KeptOutboxSender({
    ...opts,
    fetch: async (_url, init) => {
      sent.push(new Uint8Array(init!.body as ArrayBuffer))
      if (sent.length === 1) throw new Error('lost response')
      return new Response('{"sequence":1}', { status: 200 })
    },
  })
  await expect(send.sendNext()).rejects.toThrow()
  expect((await outbox.operations(link, roomId, sender))[0]!.acknowledged).toBe(false)
  expect((await send.sendNext()).status).toBe('relay-accepted')
  expect(sent).toHaveLength(2)
  expect(sent[0]).toEqual(sent[1])
  expect((await outbox.operations(link, roomId, sender))[0]!.acknowledged).toBe(true)
  outbox.close()
})

it('restores a large Unicode paste and subsequent edit', async () => {
  const { outbox, sender, opts } = await setup()
  const c = await KeptEditController.open(opts)
  const input = 'x'.repeat(8191) + '🌸' + '🍀'.repeat(35000)
  await c.replace(0, 0, input)
  await c.replace(input.length, input.length, 'later')
  await c.close()
  expect((await outbox.operations(link, roomId, sender)).length).toBeGreaterThan(1)
  const reopened = await KeptEditController.open(opts)
  expect(reopened.text()).toBe(input + 'later')
  await reopened.close()
  outbox.close()
})
it('failed close retains edits for a later close retry', async () => {
  const { outbox, sender, opts } = await setup()
  const enqueue = outbox.enqueue.bind(outbox)
  let fail = true
  outbox.enqueue = async (...args) => {
    if (fail) throw new Error('disk')
    return enqueue(...args)
  }
  const c = await KeptEditController.open(opts)
  await c.replace(0, 0, 'unsaved')
  await expect(c.close()).rejects.toThrow('disk')
  expect(await outbox.operations(link, roomId, sender)).toHaveLength(0)
  fail = false
  await c.close()
  expect(await outbox.operations(link, roomId, sender)).toHaveLength(1)
  outbox.close()
})

it('restores local edits depending on durably stored remote content', async () => {
  const { outbox, sender, opts } = await setup()
  const c = await KeptEditController.open(opts)
  const remote = new Y.Doc()
  remote.getText('content').insert(0, 'remote')
  await c.applyRemote(Y.encodeStateAsUpdate(remote))
  await c.replace(6, 6, ' local')
  await c.close()
  expect(await outbox.operations(link, roomId, sender)).toHaveLength(1)
  const reopened = await KeptEditController.open(opts)
  expect(reopened.text()).toBe('remote local')
  await reopened.close()
  remote.destroy()
  outbox.close()
})
it('does not expose remote state if its persistence fails', async () => {
  const { outbox, opts } = await setup()
  const c = await KeptEditController.open(opts)
  const remote = new Y.Doc()
  remote.getText('content').insert(0, 'remote')
  outbox.saveRemote = async () => {
    throw new Error('disk')
  }
  await expect(c.applyRemote(Y.encodeStateAsUpdate(remote))).rejects.toThrow('disk')
  expect(c.text()).toBe('')
  await c.close()
  remote.destroy()
  outbox.close()
})

it.each(['delete', 'reorder', 'add'])('rejects %s of remote recovery rows', async (mutation) => {
  const { outbox, sender, opts, name } = await setup()
  const c = await KeptEditController.open(opts)
  const a = new Y.Doc()
  a.getText('content').insert(0, 'one')
  const b = new Y.Doc()
  b.getText('content').insert(0, 'two')
  await c.applyRemote(Y.encodeStateAsUpdate(a))
  await c.applyRemote(Y.encodeStateAsUpdate(b))
  await c.close()
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name)
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('remote', 'readwrite')
    const store = tx.objectStore('remote')
    const get = store.getAll()
    get.onsuccess = () => {
      const [first, second] = get.result
      if (mutation === 'delete') store.delete([sender, first.id])
      if (mutation === 'reorder') {
        store.put({ ...first, body: second.body })
        store.put({ ...second, body: first.body })
      }
      if (mutation === 'add') store.add({ ...first, id: '0000000000000003' })
    }
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
  db.close()
  await expect(KeptEditController.open(opts)).rejects.toThrow()
  a.destroy()
  b.destroy()
  outbox.close()
})
it('deduplicates repeated remote delivery', async () => {
  const { outbox, sender, opts } = await setup()
  const c = await KeptEditController.open(opts)
  const remote = new Y.Doc()
  remote.getText('content').insert(0, 'remote')
  const update = Y.encodeStateAsUpdate(remote)
  for (let i = 0; i < 10; i++) await c.applyRemote(update)
  await c.close()
  expect((await outbox.recoveryState(link, roomId, sender)).remote).toHaveLength(1)
  remote.destroy()
  outbox.close()
})
it('aborts remote row and authenticated counter together on interrupted transaction', async () => {
  const { outbox, sender, opts } = await setup()
  const c = await KeptEditController.open(opts)
  const remote = new Y.Doc()
  remote.getText('content').insert(0, 'remote')
  const add = IDBObjectStore.prototype.add
  IDBObjectStore.prototype.add = function (...args) {
    const result = add.apply(this, args)
    if (this.name === 'remote') this.transaction.abort()
    return result
  }
  try {
    await expect(c.applyRemote(Y.encodeStateAsUpdate(remote))).rejects.toThrow()
  } finally {
    IDBObjectStore.prototype.add = add
  }
  expect(c.text()).toBe('')
  expect((await outbox.recoveryState(link, roomId, sender)).remote).toHaveLength(0)
  await c.close()
  remote.destroy()
  outbox.close()
})
it('serializes remote persistence and rejects an oversized combined edit without changing the document', async () => {
  const { outbox, opts } = await setup()
  const c = await KeptEditController.open(opts)
  const remote = new Y.Doc()
  remote.getText('content').insert(0, 'r'.repeat(600_000))
  const save = outbox.saveRemote.bind(outbox)
  let release!: () => void, started!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const ready = new Promise<void>((r) => {
    started = r
  })
  outbox.saveRemote = async (...args) => {
    started()
    await gate
    return save(...args)
  }
  const pending = c.applyRemote(Y.encodeStateAsUpdate(remote))
  await ready
  await expect(c.replace(0, 0, 'l'.repeat(600_000))).rejects.toThrow('remote update in progress')
  release()
  await pending
  expect(c.text()).toBe('r'.repeat(600_000))
  await c.close()
  const reopened = await KeptEditController.open(opts)
  expect(reopened.text()).toBe('r'.repeat(600_000))
  await reopened.close()
  remote.destroy()
  outbox.close()
}, 30000)

it('excludes a second controller and releases the writer after close', async () => {
  const { outbox, opts } = await setup()
  const c = await KeptEditController.open(opts)
  await expect(KeptEditController.open(opts)).rejects.toThrow('already open')
  await c.replace(0, 0, 'a'.repeat(600_000))
  await c.close()
  const next = await KeptEditController.open(opts)
  await expect(next.replace(0, 0, 'b'.repeat(600_000))).rejects.toThrow('capacity')
  expect(next.text()).toBe('a'.repeat(600_000))
  await next.close()
  outbox.close()
})
it('rejects stale offsets while a remote change is being persisted', async () => {
  const { outbox, opts } = await setup()
  const c = await KeptEditController.open(opts)
  await c.replace(0, 0, 'abc')
  const remote = new Y.Doc()
  remote.getText('content').insert(0, 'X')
  const save = outbox.saveRemote.bind(outbox)
  let release!: () => void, started!: () => void
  const gate = new Promise<void>((r) => {
      release = r
    }),
    ready = new Promise<void>((r) => {
      started = r
    })
  outbox.saveRemote = async (...args) => {
    started()
    await gate
    return save(...args)
  }
  const pending = c.applyRemote(Y.encodeStateAsUpdate(remote))
  await ready
  await expect(c.replace(1, 1, '!')).rejects.toThrow('remote update in progress')
  release()
  await pending
  expect(c.text()).not.toContain('!')
  await c.close()
  remote.destroy()
  outbox.close()
})
