import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import bomVector from '../../testdata/kept-multi-payload-bom-vector.json'
import vector from '../../testdata/kept-multi-payload-vectors.json'
import { decodeKeptMultiPayload, encodeKeptMultiPayload } from '../src/kept-multi-payload.ts'

const wire = Uint8Array.from(Buffer.from(vector.payload, 'base64url'))

describe('multi-file checkpoint', () => {
  it('reads and exactly re-encodes the Go vector with text, comments and attachment inventory', () => {
    const result = decodeKeptMultiPayload(wire, 4)
    expect(result.manifest.map((f) => f.id)).toEqual([0, 7, 8, 9])
    expect(result.attachments).toEqual(['assets/0123456789abcdef0123456789abcdef.png'])
    const doc = new Y.Doc()
    Y.applyUpdate(doc, result.documents.get(8)!)
    expect(doc.getText('content').toString()).toContain(result.attachments[0])
    doc.destroy()
    expect(encodeKeptMultiPayload(result)).toEqual(wire)
  })

  it('rejects missing assets, metadata, canvas, duplicate paths and malformed wire', () => {
    const value = decodeKeptMultiPayload(wire, 4)
    expect(() => encodeKeptMultiPayload({ ...value, attachments: [] })).toThrow()
    expect(() =>
      encodeKeptMultiPayload({ ...value, attachments: [value.attachments[0] + '\n'] }),
    ).toThrow()
    expect(() =>
      encodeKeptMultiPayload({
        ...value,
        attachments: [...value.attachments, ...value.attachments],
      }),
    ).toThrow()
    const docs = new Map(value.documents)
    docs.delete(9)
    expect(() => encodeKeptMultiPayload({ ...value, documents: docs })).toThrow()
    expect(() =>
      encodeKeptMultiPayload({
        ...value,
        manifest: value.manifest.map((f) => (f.id === 8 ? { ...f, format: 'canvas' } : f)),
      }),
    ).toThrow()
    expect(() => decodeKeptMultiPayload(wire.subarray(0, wire.length - 1), 4)).toThrow()
    expect(() => decodeKeptMultiPayload(new Uint8Array([...wire, 0]), 4)).toThrow()
  })
})

it('rejects the shared BOM-prefixed inventory wire', () => {
  const input = Uint8Array.from(Buffer.from(bomVector.payload, 'base64url'))
  expect(() => decodeKeptMultiPayload(input, 4)).toThrow()
})
