import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import * as Y from 'yjs'
import access from '../../testdata/kept-access-vectors.json'
import { parseKeptFragment } from '../src/kept-access.ts'
import { KeptOutbox } from '../src/kept-outbox.ts'
import { KeptEditController, type KeptEditStatus } from '../src/kept-edit-controller.ts'

const link = parseKeptFragment(access.edit)!
const roomId = 'AAECAwQFBgcICQoLDA0ODw'
const context = { roomId, epoch: new Uint8Array(32).fill(3), generation: 1 }
const until = async (f: () => boolean) => {
 for (let i = 0; i < 1000 && !f(); i++) await new Promise(r => setTimeout(r, 2))
 if (!f()) throw new Error('timed out')
}
async function setup() {
 const outbox = await KeptOutbox.open(`review-${crypto.randomUUID()}`)
 const sender = await outbox.createSender(link, roomId)
 let status: KeptEditStatus = 'idle'
 const opts = { url:'https://example.test', link, context, sender, outbox, baseline:Y.encodeStateAsUpdate(new Y.Doc()), onStatus:(x:KeptEditStatus) => { status = x }, fetch: async () => { throw new Error('offline') } }
 return {outbox, sender, opts, status: () => status}
}
it('close drains all edits and restores them', async () => {
 const {outbox, sender, opts} = await setup()
 const enqueue = outbox.enqueue.bind(outbox)
 let release!: () => void
 const gate = new Promise<void>(r => { release = r })
 outbox.enqueue = async (...args) => { await gate; return enqueue(...args) }
 const c = await KeptEditController.open(opts)
 c.replace(0, 0, 'one'); c.replace(3, 3, 'two')
 const done = c.close(); release(); await done
 expect(await outbox.operations(link, roomId, sender)).toHaveLength(2)
 const reopened = await KeptEditController.open(opts)
 expect(reopened.text()).toBe('onetwo')
 await reopened.close(); outbox.close()
})
it('remote updates are never re-sent and unknown roots are rejected', async () => {
 const {outbox, sender, opts} = await setup()
 const c = await KeptEditController.open(opts)
 const remote = new Y.Doc(); remote.getText('content').insert(0, 'remote')
 c.applyRemote(Y.encodeStateAsUpdate(remote))
 expect(c.text()).toBe('remote')
 const wrong = new Y.Doc(); wrong.getMap('other').set('key', 'value')
 expect(() => c.applyRemote(Y.encodeStateAsUpdate(wrong))).toThrow()
 await c.close()
 expect(await outbox.operations(link, roomId, sender)).toHaveLength(0)
 remote.destroy(); wrong.destroy(); outbox.close()
})
it('concurrent senders can report idle while another operation remains pending', async () => {
 const {outbox, sender, opts} = await setup()
 const { KeptOutboxSender } = await import('../src/kept-outbox-sender.ts')
 await outbox.enqueue(link, roomId, sender, Uint8Array.of(1))
 await outbox.enqueue(link, roomId, sender, Uint8Array.of(2))
 const fetch = async () => new Response('{"sequence":1}', {status:200})
 const a = new KeptOutboxSender({...opts, fetch})
 const b = new KeptOutboxSender({...opts, fetch})
 const prepare = outbox.prepare.bind(outbox)
 let first = true
 outbox.prepare = async (...args) => {
  if (first) { first = false; expect((await b.sendNext()).status).toBe('relay-accepted') }
  return prepare(...args)
 }
 expect((await a.sendNext()).status).toBe('relay-accepted')
 const rows = await outbox.operations(link, roomId, sender)
 expect(rows.map(r => r.acknowledged)).toEqual([true,true])
 outbox.close()
})

it('retries identical stored ciphertext after a lost response', async () => {
 const {outbox, sender, opts} = await setup()
 const { KeptOutboxSender } = await import('../src/kept-outbox-sender.ts')
 await outbox.enqueue(link, roomId, sender, Uint8Array.of(1))
 const sent: Uint8Array[] = []
 const send = new KeptOutboxSender({...opts, fetch: async (_url, init) => {
   sent.push(new Uint8Array(init!.body as ArrayBuffer))
   if (sent.length === 1) throw new Error('lost response')
   return new Response('{"sequence":1}', {status:200})
 }})
 await expect(send.sendNext()).rejects.toThrow()
 expect((await outbox.operations(link, roomId, sender))[0]!.acknowledged).toBe(false)
 expect((await send.sendNext()).status).toBe('relay-accepted')
 expect(sent).toHaveLength(2)
 expect(sent[0]).toEqual(sent[1])
 expect((await outbox.operations(link, roomId, sender))[0]!.acknowledged).toBe(true)
 outbox.close()
})

it('restores a large Unicode paste and subsequent edit', async () => {
 const {outbox, sender, opts} = await setup()
 const c = await KeptEditController.open(opts)
 const input = 'x'.repeat(8191) + '🌸' + '🍀'.repeat(35000)
 c.replace(0, 0, input); c.replace(input.length, input.length, 'later')
 await c.close()
 expect((await outbox.operations(link, roomId, sender)).length).toBeGreaterThan(1)
 const reopened = await KeptEditController.open(opts)
 expect(reopened.text()).toBe(input + 'later')
 await reopened.close(); outbox.close()
})
it('failed close retains edits for a later close retry', async () => {
 const {outbox, sender, opts} = await setup()
 const enqueue = outbox.enqueue.bind(outbox); let fail = true
 outbox.enqueue = async (...args) => { if (fail) throw new Error('disk'); return enqueue(...args) }
 const c = await KeptEditController.open(opts)
 c.replace(0, 0, 'unsaved')
 await expect(c.close()).rejects.toThrow('disk')
 expect(await outbox.operations(link, roomId, sender)).toHaveLength(0)
 fail = false; await c.close()
 expect(await outbox.operations(link, roomId, sender)).toHaveLength(1)
 outbox.close()
})
