import { expect, it } from 'vitest'
import * as Y from 'yjs'
import access from '../../testdata/kept-access-vectors.json'
import fixture from '../../testdata/kept-inventory-update-vectors.json'
import { signingPair } from '../src/access-crypto.ts'
import { decrypt, encrypt } from '../src/cipher.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { replayKeptInventory } from '../src/kept-inventory-replay.ts'
import {
  decodeKeptInventoryUpdate,
  encodeKeptInventoryUpdate,
} from '../src/kept-inventory-update.ts'
import { KeptLedger } from '../src/kept-ledger.ts'
import {
  createKeptSenderCertificate,
  type KeptRecord,
  openKeptRecord,
  sealKeptRecord,
} from '../src/kept-record.ts'

const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const wire = () => bytes(fixture.wire)

it('interoperates with the shared canonical wire fixture and rejects malformed data', () => {
  const update = bytes(fixture.update)
  expect(encodeKeptInventoryUpdate({ update, additions: fixture.additions })).toEqual(wire())
  expect(decodeKeptInventoryUpdate(wire())).toEqual({ update, additions: fixture.additions })
  for (const raw of [
    wire().slice(0, -1),
    Uint8Array.from([...wire(), 0]),
    Uint8Array.of(0),
    new Uint8Array(1048576),
  ])
    expect(() => decodeKeptInventoryUpdate(raw)).toThrow()
  for (const additions of [
    [fixture.additions[1]!, fixture.additions[0]!],
    [fixture.additions[0]!, fixture.additions[0]!],
    ['\uFEFF' + fixture.additions[0]],
    ['assets/' + 'a'.repeat(32) + '.svg'],
    Array(1025).fill(fixture.additions[0]),
  ])
    expect(() => encodeKeptInventoryUpdate({ update, additions })).toThrow()
  expect(() => encodeKeptInventoryUpdate({ update: Uint8Array.of(255), additions: [] })).toThrow()
})

it('binds the complete payload to the sender signature and encrypted context', async () => {
  const link = parseKeptFragment(access.edit)!
  const keys = await deriveKeptRoomKeys(link, access.roomId)
  const sender = await signingPair(new Uint8Array(32).fill(11))
  const cert = await createKeptSenderCertificate(keys, sender.publicKey)
  const context = { roomId: access.roomId, epoch: new Uint8Array(32).fill(5), generation: 1 }
  const sealed = await sealKeptRecord(keys, context, sender.sign, cert, 1, wire())
  expect((await openKeptRecord(keys, context, sealed)).message).toEqual(wire())
  const plaintext = await decrypt(keys.frameKey, sealed)
  plaintext[plaintext.length - 65] = (plaintext[plaintext.length - 65] ?? 0) ^ 1
  await expect(
    openKeptRecord(keys, context, await encrypt(keys.frameKey, plaintext)),
  ).rejects.toThrow()
})

it('replays authenticated concurrent additions, duplicates and deletions without removing inventory', async () => {
  const a = new Uint8Array(32).fill(1),
    b = new Uint8Array(32).fill(2)
  const record = (
    sender: Uint8Array,
    sequence: number,
    update: string,
    additions: string[],
  ): KeptRecord => ({
    access: 'edit',
    sender,
    sequence,
    message: encodeKeptInventoryUpdate({ update: bytes(update), additions }),
  })
  const first = record(a, 1, fixture.first, [fixture.additions[0]!]),
    second = record(b, 1, fixture.second, [fixture.additions[1]!]),
    deletion = record(a, 2, fixture.deletion, [])
  for (const records of [
    [first, second, first, deletion],
    [second, first, deletion],
  ]) {
    const result = await replayKeptInventory({
      text: bytes(fixture.update),
      inventory: [],
      ledger: KeptLedger.empty(10),
      records,
    })
    const doc = new Y.Doc()
    Y.applyUpdate(doc, result.text)
    expect(doc.getText('content').toString()).toBe('Bhello')
    expect(result.inventory).toEqual(fixture.additions)
    expect(result.ledger.snapshot()).toHaveLength(3)
    doc.destroy()
  }
  await expect(
    replayKeptInventory({
      text: bytes(fixture.update),
      inventory: [],
      ledger: KeptLedger.empty(10),
      records: [{ ...first, message: Uint8Array.of(0, 1) }],
    }),
  ).rejects.toThrow()
  await expect(
    replayKeptInventory({
      text: bytes(fixture.update),
      inventory: [],
      ledger: KeptLedger.empty(10),
      records: [{ ...first, access: 'comment' }],
    }),
  ).rejects.toThrow()
  const collision = record(a, 1, fixture.second, [fixture.additions[1]!])
  await expect(
    replayKeptInventory({
      text: bytes(fixture.update),
      inventory: [],
      ledger: KeptLedger.empty(10),
      records: [first, collision],
    }),
  ).rejects.toThrow('sequence')
  await expect(
    replayKeptInventory({
      text: bytes(fixture.update),
      inventory: [],
      ledger: KeptLedger.empty(100),
      records: Array(65).fill(first),
    }),
  ).rejects.toThrow()
})

it('requires declared references and keeps state unchanged on rejection', async () => {
  const sender = new Uint8Array(32).fill(7)
  const build = (additions: string[]): KeptRecord => ({
    access: 'edit',
    sender,
    sequence: 1,
    message: encodeKeptInventoryUpdate({ update: bytes(fixture.asset), additions }),
  })
  const ledger = KeptLedger.empty(5)
  const text = bytes(fixture.update)
  await expect(
    replayKeptInventory({ text, inventory: [], ledger, records: [build([])] }),
  ).rejects.toThrow('undeclared attachment')
  expect(ledger.snapshot()).toEqual([])
  expect(text).toEqual(bytes(fixture.update))
  const accepted = await replayKeptInventory({
    text,
    inventory: [],
    ledger,
    records: [build([fixture.additions[0]!])],
  })
  expect(accepted.inventory).toEqual([fixture.additions[0]])
})

it('bounds inventory count and rejects noncanonical bytes', () => {
  const update = bytes(fixture.update)
  const additions = Array.from(
    { length: 1024 },
    (_, i) => `assets/${i.toString(16).padStart(32, '0')}.png`,
  )
  const encoded = encodeKeptInventoryUpdate({ update, additions })
  expect(decodeKeptInventoryUpdate(encoded).additions).toEqual(additions)
  expect(() =>
    encodeKeptInventoryUpdate({
      update,
      additions: [...additions, 'assets/ffffffffffffffffffffffffffffffff.png'],
    }),
  ).toThrow()
  const malformed = encoded.slice()
  malformed[malformed.length - 1] = 0xff
  expect(() => decodeKeptInventoryUpdate(malformed)).toThrow()
  const truncated = encoded.slice()
  truncated[0] = (truncated[0] ?? 0) ^ 1
  expect(() => decodeKeptInventoryUpdate(truncated)).toThrow()
})

it('rejects invalid UTF-8 in an incremental Yjs update', () => {
  const update = bytes(fixture.update)
  update[update.length - 2] = 0xff
  expect(() => encodeKeptInventoryUpdate({ update, additions: [] })).toThrow()
})
