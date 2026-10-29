import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import access from '../../testdata/kept-access-vectors.json'
import goVector from '../../testdata/kept-text-payload-go-vectors.json'
import vector from '../../testdata/kept-text-payload-vectors.json'
import { decrypt, encrypt } from '../src/cipher.ts'
import { deriveKeptRoomKeys, parseKeptFragment } from '../src/kept-access.ts'
import { MAX_KEPT_CHECKPOINT_PAYLOAD, openKeptCheckpoint } from '../src/kept-checkpoint.ts'
import { decodeKeptTextPayload, encodeKeptTextPayload } from '../src/kept-text-payload.ts'
import { fromBase64Url } from '../src/key.ts'

const payload = () => fromBase64Url(vector.payload)
describe('kept text checkpoint payload', () => {
  it('restores Yjs identities and comment anchors across concurrent edits', async () => {
    const link = parseKeptFragment(access.read)
    if (!link) throw new Error('invalid vector')
    const keys = await deriveKeptRoomKeys(link, vector.roomId)
    const context = {
      roomId: vector.roomId,
      epoch: fromBase64Url(vector.epoch),
      generation: vector.generation,
      cutoff: vector.cutoff,
    }
    const checkpoint = fromBase64Url(vector.checkpoint)
    const opened = await openKeptCheckpoint(keys, context, checkpoint)
    expect(opened).toEqual(payload())
    const value = decodeKeptTextPayload(opened, 4)
    expect(encodeKeptTextPayload(value)).toEqual(opened)
    const main = new Y.Doc(),
      meta = new Y.Doc()
    const mainState = value.documents.get(0),
      metaState = value.documents.get(7)
    if (!mainState || !metaState) throw new Error('missing docs')
    Y.applyUpdate(main, mainState)
    Y.applyUpdate(meta, metaState)
    Y.applyUpdate(main, fromBase64Url(vector.updateA))
    Y.applyUpdate(main, fromBase64Url(vector.updateB))
    expect(main.getText('content').toString()).toBe(vector.merged)
    const thread = meta.getMap<Y.Map<unknown>>('comments').get('c1')
    const anchor = thread?.get('anchor') as { start: string; end: string }
    const resolve = (s: string) =>
      Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(Uint8Array.from(Buffer.from(s, 'base64'))),
        main,
      )?.index
    expect(
      main.getText('content').toString().slice(resolve(anchor.start), resolve(anchor.end)),
    ).toBe('hello')
    const plain = await decrypt(keys.frameKey, checkpoint)
    const head = new TextEncoder().encode('pedit/v6/checkpoint\0').length + 22 + 32 + 8 + 8 + 4
    plain[head] = (plain[head] ?? 0) ^ 1
    await expect(
      openKeptCheckpoint(keys, context, await encrypt(keys.frameKey, plain)),
    ).rejects.toThrow()
    main.destroy()
    meta.destroy()
  })
  it('restores states created independently by Go', () => {
    const value = decodeKeptTextPayload(payload(), 4)
    value.documents = new Map([
      [0, fromBase64Url(goVector.main)],
      [7, fromBase64Url(goVector.metadata)],
    ])
    const restored = decodeKeptTextPayload(encodeKeptTextPayload(value), 4)
    const main = new Y.Doc(),
      meta = new Y.Doc()
    const mainState = restored.documents.get(0),
      metaState = restored.documents.get(7)
    if (!mainState || !metaState) throw new Error('missing documents')
    Y.applyUpdate(main, mainState)
    Y.applyUpdate(meta, metaState)
    expect(main.getText('content').toString()).toBe('from Go')
    expect(meta.getMap<Y.Map<string>>('comments').get('c1')?.get('quote')).toBe('from Go')
    main.destroy()
    meta.destroy()
  })
  it('rejects unknown documents, unverified or present attachments, canvas and malformed data', () => {
    const value = decodeKeptTextPayload(payload(), 4)
    expect(() => encodeKeptTextPayload({ ...value, attachments: 'unverified' })).toThrow()
    expect(() => encodeKeptTextPayload({ ...value, attachments: 'present' })).toThrow()
    expect(() =>
      encodeKeptTextPayload({
        ...value,
        documents: new Map([...value.documents, [8, new Uint8Array([1])]]),
      }),
    ).toThrow()
    expect(() =>
      encodeKeptTextPayload({
        ...value,
        manifest: value.manifest.map((f) => (f.id === 0 ? { ...f, format: 'canvas' } : f)),
      }),
    ).toThrow()
    expect(() =>
      encodeKeptTextPayload({
        ...value,
        manifest: value.manifest.map((f) => (f.id === 7 ? { ...f, path: 'other.json' } : f)),
      }),
    ).toThrow()
    for (const bad of [new Uint8Array([255]), fromBase64Url(vector.updateA)]) {
      expect(() =>
        encodeKeptTextPayload({
          ...value,
          documents: new Map([
            [0, bad],
            [7, value.documents.get(7)!],
          ]),
        }),
      ).toThrow()
    }
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'assets/0123456789abcdef0123456789abcdef.png')
    expect(() =>
      encodeKeptTextPayload({
        ...value,
        documents: new Map([
          [0, Y.encodeStateAsUpdate(doc)],
          [7, value.documents.get(7)!],
        ]),
      }),
    ).toThrow()
    doc.getText('content').delete(0, doc.getText('content').length)
    doc.getText('content').insert(0, 'x'.repeat(MAX_KEPT_CHECKPOINT_PAYLOAD))
    expect(() =>
      encodeKeptTextPayload({
        ...value,
        documents: new Map([
          [0, Y.encodeStateAsUpdate(doc)],
          [7, value.documents.get(7)!],
        ]),
      }),
    ).toThrow()
    doc.destroy()
    const withSubdoc = new Y.Doc()
    withSubdoc.getMap('other').set('child', new Y.Doc())
    expect(() =>
      encodeKeptTextPayload({
        ...value,
        documents: new Map([
          [0, Y.encodeStateAsUpdate(withSubdoc)],
          [7, value.documents.get(7)!],
        ]),
      }),
    ).toThrow()
    withSubdoc.destroy()
    const input = payload()
    expect(() => decodeKeptTextPayload(input.slice(0, -1), 4)).toThrow()
    expect(() => decodeKeptTextPayload(Uint8Array.from([...input, 0]), 4)).toThrow()
    const corrupt = input.slice()
    const firstLength = new TextEncoder().encode('pedit/v6/text-checkpoint\0').length + 1
    const manifestSize = new DataView(corrupt.buffer, corrupt.byteOffset).getUint32(firstLength)
    corrupt[firstLength + 4 + manifestSize + 4] = 255
    expect(() => decodeKeptTextPayload(corrupt, 4)).toThrow()
    const unsupported = input.slice()
    unsupported[new TextEncoder().encode('pedit/v6/text-checkpoint\0').length] = 1
    expect(() => decodeKeptTextPayload(unsupported, 4)).toThrow()
    expect(() =>
      decodeKeptTextPayload(new Uint8Array(MAX_KEPT_CHECKPOINT_PAYLOAD + 1), 4),
    ).toThrow()
  })
})

it('snapshots document inputs before later caller callbacks can mutate them', () => {
  const value = decodeKeptTextPayload(payload(), 4)
  const text = value.documents.get(0)!
  const expected = text.slice()
  let reads = 0
  const input = {
    ...value,
    get manifest() {
      if (++reads === 2) text[0] = 255
      return value.manifest
    },
  }
  const encoded = encodeKeptTextPayload(input)
  expect(text[0]).toBe(255)
  expect(decodeKeptTextPayload(encoded, 4).documents.get(0)).toEqual(expected)
})

it('parses a private copy of caller-provided bytes', () => {
  class CallerBytes extends Uint8Array {
    override slice(_start?: number, _end?: number): never {
      throw new Error('caller-controlled slice')
    }
  }
  expect(decodeKeptTextPayload(new CallerBytes(payload()), 4).documents.get(0)).toBeDefined()
})
