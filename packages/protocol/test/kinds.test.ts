import { describe, expect, it } from 'vitest'
import { CHECKPOINT, CHECKPOINT_REFUSED, KEEP, KEPT, LOG_FULL } from '../src/close.ts'
import {
  decodeCheckpoint,
  decodeLogged,
  decodeUint64,
  encodeCheckpoint,
  encodeLogEnd,
  encodeLogged,
  encodeUint64,
  Kind,
  parseNumbers,
  splitKind,
  withKind,
} from '../src/kinds.ts'

describe('kinds', () => {
  it('number the kinds of protocol version 6', () => {
    expect(Kind).toEqual({
      Live: 0,
      Entry: 1,
      Snapshot: 2,
      Checkpoint: 3,
      Logged: 4,
      Replay: 5,
      LogEnd: 6,
    })
  })

  it('put the kind byte before the payload and take it off again', () => {
    const message = withKind(Kind.Entry, new Uint8Array([7, 8]), new Uint8Array([9]))
    expect([...message]).toEqual([1, 7, 8, 9])
    const split = splitKind(message)
    expect(split?.kind).toBe(1)
    expect([...(split?.payload ?? [])]).toEqual([7, 8, 9])
    expect(splitKind(new Uint8Array())).toBeUndefined()
  })

  it('write ids, cutoffs and tails as big-endian uint64', () => {
    expect([...encodeUint64(258)]).toEqual([0, 0, 0, 0, 0, 0, 1, 2])
    expect(decodeUint64(encodeUint64(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
    expect(decodeUint64(new Uint8Array([0, 0, 0, 0, 0, 0, 1]))).toBeUndefined()
    expect(decodeUint64(new Uint8Array(8).fill(255))).toBeUndefined()
    expect(() => encodeUint64(-1)).toThrow()
    expect(() => encodeUint64(1.5)).toThrow()
  })

  it('round-trip logged entries, checkpoints and the end of a log', () => {
    const entry = new Uint8Array([5, 6, 7])
    const logged = encodeLogged(300, entry)
    expect(logged[0]).toBe(Kind.Logged)
    const decoded = decodeLogged(logged.subarray(1))
    expect(decoded?.id).toBe(300)
    expect([...(decoded?.entry ?? [])]).toEqual([5, 6, 7])
    const checkpoint = encodeCheckpoint(4, entry)
    expect(checkpoint[0]).toBe(Kind.Checkpoint)
    const parsed = decodeCheckpoint(checkpoint.subarray(1))
    expect(parsed?.cutoff).toBe(4)
    expect([...(parsed?.bundle ?? [])]).toEqual([5, 6, 7])
    expect(decodeCheckpoint(new Uint8Array(3))).toBeUndefined()
    expect([...encodeLogEnd(9)]).toEqual([6, 0, 0, 0, 0, 0, 0, 0, 9])
  })

  it('spell the relay texts as the design does', () => {
    expect([KEPT, KEEP, CHECKPOINT, CHECKPOINT_REFUSED, LOG_FULL]).toEqual([
      'kept',
      'keep',
      'checkpoint',
      'checkpoint refused',
      'log full',
    ])
    expect(parseNumbers(KEPT, 'kept 1700000000000', 1)).toEqual([1700000000000])
    expect(parseNumbers(KEEP, 'keep 60 0', 2)).toEqual([60, 0])
    expect(parseNumbers(CHECKPOINT, 'checkpoint 3 7', 2)).toEqual([3, 7])
    expect(parseNumbers(CHECKPOINT, CHECKPOINT_REFUSED, 2)).toBeUndefined()
    expect(parseNumbers(KEPT, 'kept x', 1)).toBeUndefined()
    expect(parseNumbers(KEPT, 'kept 1 2', 1)).toBeUndefined()
  })
})
