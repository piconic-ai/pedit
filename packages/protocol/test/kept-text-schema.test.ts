import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import vector from '../../testdata/kept-text-payload-vectors.json'
import { decodeKeptTextPayload, encodeKeptTextPayload } from '../src/kept-text-payload.ts'
import { checkKeptTextState } from '../src/kept-text-schema.ts'
import { fromBase64Url } from '../src/key.ts'

describe('kept text state validation', () => {
  it('accepts empty, Go/JS fixtures, and plain editing states', () => {
    const v = decodeKeptTextPayload(fromBase64Url(vector.payload), 4)
    expect(checkKeptTextState(v.documents.get(0)!)).toBe(true)
    const d = new Y.Doc()
    expect(checkKeptTextState(Y.encodeStateAsUpdate(d))).toBe(true)
    d.getText('content').insert(0, 'hello')
    expect(checkKeptTextState(Y.encodeStateAsUpdate(d))).toBe(true)
    d.getText('content').delete(0, 2)
    expect(checkKeptTextState(Y.encodeStateAsUpdate(d))).toBe(true)
  })
  it('rejects unknown roots and trailing bytes', () => {
    const v = decodeKeptTextPayload(fromBase64Url(vector.payload), 4)
    const d = new Y.Doc()
    d.getText('unexpected').insert(0, 'lost')
    expect(checkKeptTextState(Y.encodeStateAsUpdate(d))).toBe(false)
    expect(checkKeptTextState(Uint8Array.from([...v.documents.get(0)!, 0]))).toBe(false)
    v.documents.set(0, Y.encodeStateAsUpdate(d))
    expect(() => encodeKeptTextPayload(v)).toThrow()
  })
})

it('rejects a valid Yjs garbage-collected struct outside the supported subset', () => {
  const gc = Uint8Array.of(1, 1, 1, 0, 0, 1, 0)
  const doc = new Y.Doc()
  expect(() => Y.applyUpdate(doc, gc)).not.toThrow()
  expect(checkKeptTextState(gc)).toBe(false)
  doc.destroy()
})

it('accepts ordinary text after full deletion', () => {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, 'delete everything')
  text.delete(0, text.length)
  expect(checkKeptTextState(Y.encodeStateAsUpdate(doc))).toBe(true)
  doc.destroy()
})

it('rejects an overlong varuint', () => {
  expect(checkKeptTextState(Uint8Array.of(0x80, 0, 0))).toBe(false)
})

it('rejects a BOM-prefixed root name', () => {
  const doc = new Y.Doc()
  doc.getText('\ufeffcontent').insert(0, 'hidden')
  expect(checkKeptTextState(Y.encodeStateAsUpdate(doc))).toBe(false)
})
