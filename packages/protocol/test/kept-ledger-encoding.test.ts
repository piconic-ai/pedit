import { describe, expect, it } from 'vitest'
import access from '../../testdata/kept-access-vectors.json'
import fixture from '../../testdata/kept-ledger-encoding-vectors.json'
import { decrypt, encrypt } from '../src/cipher.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { MAX_KEPT_CHECKPOINT_PAYLOAD, openKeptCheckpoint } from '../src/kept-checkpoint.ts'
import { KeptLedger, type KeptReceipt } from '../src/kept-ledger.ts'
import { decodeKeptLedger, encodeKeptLedger } from '../src/kept-ledger-encoding.ts'
import { fromBase64Url } from '../src/key.ts'

const bytes = () => fromBase64Url(fixture.encoded)
const HEADER = new TextEncoder().encode('pedit/v6/ledger\0').length + 4
const ITEM = 74

describe('kept ledger checkpoint encoding', () => {
  it('uses the shared canonical encoding independent of insertion order', () => {
    const encoded = bytes()
    const decoded = decodeKeptLedger(4, encoded)
    expect(encodeKeptLedger(decoded)).toEqual(encoded)
    const [a, b, c, d] = decoded.snapshot()
    if (!a || !b || !c || !d) throw new Error('invalid fixture')
    expect(encodeKeptLedger(KeptLedger.restore(4, [c, a, b, d]))).toEqual(encoded)
    expect(() => decodeKeptLedger(3, encoded)).toThrow()
  })
  it('rejects invalid fields, duplicates, noncanonical order, truncation and trailing data', () => {
    const input = bytes()
    for (const offset of [0, HEADER - 1, HEADER, HEADER + 40, HEADER + 73]) {
      const bad = input.slice()
      bad[offset] = 255
      expect(() => decodeKeptLedger(4, bad)).toThrow()
    }
    const gap = input.slice()
    gap[HEADER + 3 * ITEM + 40] = 2
    expect(() => decodeKeptLedger(4, gap)).toThrow()
    const duplicate = input.slice()
    duplicate.set(duplicate.slice(HEADER, HEADER + ITEM), HEADER + ITEM)
    expect(() => decodeKeptLedger(4, duplicate)).toThrow()
    const swapped = input.slice()
    swapped.set(input.slice(HEADER + ITEM, HEADER + 2 * ITEM), HEADER)
    swapped.set(input.slice(HEADER, HEADER + ITEM), HEADER + ITEM)
    expect(() => decodeKeptLedger(4, swapped)).toThrow()
    expect(() => decodeKeptLedger(4, input.slice(0, -1))).toThrow()
    expect(() => decodeKeptLedger(4, Uint8Array.from([...input, 0]))).toThrow()
  })
  it('opens a host-signed vector and rejects a reader-modified ledger', async () => {
    const link = parseKeptFragment(access.read)
    if (!link) throw new Error('invalid vector')
    const keys = await deriveKeptRoomKeys(link, fixture.roomId)
    const context = {
      roomId: fixture.roomId,
      epoch: fromBase64Url(fixture.epoch),
      generation: fixture.generation,
      cutoff: fixture.cutoff,
    }
    const checkpoint = fromBase64Url(fixture.checkpoint)
    const payload = await openKeptCheckpoint(keys, context, checkpoint)
    expect(payload).toEqual(bytes())
    expect(encodeKeptLedger(decodeKeptLedger(4, payload))).toEqual(bytes())
    const plain = await decrypt(keys.frameKey, checkpoint)
    const checkpointHeader =
      new TextEncoder().encode('pedit/v6/checkpoint\0').length + 22 + 32 + 8 + 8 + 4
    const at = checkpointHeader + HEADER + 41
    plain[at] = (plain[at] ?? 0) ^ 1
    await expect(
      openKeptCheckpoint(keys, context, await encrypt(keys.frameKey, plain)),
    ).rejects.toThrow()
  })
  it('round trips an empty ledger', () => {
    const encoded = encodeKeptLedger(KeptLedger.empty(1))
    expect(decodeKeptLedger(1, encoded).snapshot()).toEqual([])
  })
  it('rejects oversize without dropping receipts', () => {
    const max = Math.floor((MAX_KEPT_CHECKPOINT_PAYLOAD - HEADER) / ITEM)
    const entries: KeptReceipt[] = Array.from({ length: max + 1 }, (_, i) => ({
      access: 'edit',
      sender: '00'.repeat(32),
      sequence: i + 1,
      digest: '00'.repeat(32),
      outcome: 'applied',
    }))
    const largest = KeptLedger.restore(max + 1, entries.slice(0, max))
    expect(decodeKeptLedger(max + 1, encodeKeptLedger(largest)).snapshot()).toHaveLength(max)
    const tooLarge = KeptLedger.restore(max + 1, entries)
    expect(() => encodeKeptLedger(tooLarge)).toThrow()
    expect(tooLarge.snapshot()).toHaveLength(max + 1)
  })
})
