import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import vector from '../../testdata/kept-text-payload-vectors.json'
import { checkKeptCommentsState } from '../src/kept-comments-schema.ts'
import { decodeKeptTextPayload, encodeKeptTextPayload } from '../src/kept-text-payload.ts'
import { fromBase64Url } from '../src/key.ts'

describe('kept comments checkpoint schema', () => {
  it('accepts a real comments fixture with relative anchors', () => {
    const value = decodeKeptTextPayload(fromBase64Url(vector.payload), 4)
    expect(checkKeptCommentsState(value.documents.get(7)!)).toBe(true)
    expect(encodeKeptTextPayload(value)).toEqual(fromBase64Url(vector.payload))
  })
  it('rejects unknown roots, trailing bytes and overlong integers', () => {
    const value = decodeKeptTextPayload(fromBase64Url(vector.payload), 4)
    const valid = value.documents.get(7)!
    const doc = new Y.Doc()
    doc.getMap('unknown').set('c', 'value')
    for (const input of [
      Y.encodeStateAsUpdate(doc),
      Uint8Array.from([...valid, 0]),
      Uint8Array.of(0x80, 0, 0),
    ]) {
      expect(checkKeptCommentsState(input)).toBe(false)
      value.documents.set(7, input)
      expect(() => encodeKeptTextPayload(value)).toThrow()
    }
    doc.destroy()
  })
})

it('rejects a BOM-prefixed root and invalid UTF-8 in a comment value', () => {
  const root = new Y.Doc()
  root.getMap('\ufeffcomments').set('c', 'value')
  expect(checkKeptCommentsState(Y.encodeStateAsUpdate(root))).toBe(false)
  const doc = new Y.Doc()
  doc.getMap('comments').set('c', 'UniqueValue')
  const bytes = Y.encodeStateAsUpdate(doc)
  const at = bytes.indexOf('U'.charCodeAt(0))
  expect(at).toBeGreaterThanOrEqual(0)
  bytes[at] = 0xff
  expect(checkKeptCommentsState(bytes)).toBe(false)
  root.destroy()
  doc.destroy()
})

it('enforces conservative clock and encoded-size budgets', () => {
  for (const n of [1024, 1025]) {
    const doc = new Y.Doc()
    const map = doc.getMap('comments')
    doc.transact(() => {
      for (let i = 0; i < n; i++) map.set(`k${i}`, i)
    })
    expect(checkKeptCommentsState(Y.encodeStateAsUpdate(doc))).toBe(n === 1024)
    doc.destroy()
  }
  for (const size of [1_044_000, 1_044_400]) {
    const doc = new Y.Doc()
    doc.getMap('comments').set('k', 'x'.repeat(size))
    expect(checkKeptCommentsState(Y.encodeStateAsUpdate(doc))).toBe(size === 1_044_000)
    doc.destroy()
  }
})
