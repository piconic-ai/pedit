import { describe, expect, it } from 'vitest'
// Written by the Go side (internal/protocol/blob_test.go), so both compute the same.
import vectors from '../../testdata/blob-vectors.json'
import {
  BLOB_ID_PATTERN,
  blobIdFor,
  contentHash,
  decrypt,
  decryptBlob,
  deriveBlobKeys,
  encrypt,
  encryptBlob,
  fromBase64Url,
  generateKey,
  HASH_PATTERN,
  importKey,
} from '../src/index.ts'

const hex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)))
const bytes = (s: string) => new TextEncoder().encode(s)

describe('blob', () => {
  it('matches the Go implementation', async () => {
    const keys = await deriveBlobKeys(fromBase64Url(vectors.key))
    expect(vectors.cases.length).toBeGreaterThan(0)
    for (const c of vectors.cases) {
      const plaintext = hex(c.plaintext)
      expect(await contentHash(plaintext)).toBe(c.hash)
      expect(await blobIdFor(keys, c.hash)).toBe(c.blobId)
      expect(await decryptBlob(keys, fromBase64Url(c.blob), c.hash)).toEqual(plaintext)
    }
  })

  it('names content by hash', async () => {
    const hash = await contentHash(bytes('an image'))
    expect(hash).toMatch(HASH_PATTERN)
    expect(await contentHash(bytes('another'))).not.toBe(hash)
  })

  it('derives blob ids per room', async () => {
    const key = generateKey()
    const hash = await contentHash(bytes('an image'))
    const id = await blobIdFor(await deriveBlobKeys(fromBase64Url(key)), hash)
    expect(id).toMatch(BLOB_ID_PATTERN)
    expect(await blobIdFor(await deriveBlobKeys(fromBase64Url(key)), hash)).toBe(id)
    expect(await blobIdFor(await deriveBlobKeys(fromBase64Url(generateKey())), hash)).not.toBe(id)
    await expect(
      blobIdFor(await deriveBlobKeys(fromBase64Url(key)), 'not a hash'),
    ).rejects.toThrow()
  })

  it('round-trips and checks the hash', async () => {
    const keys = await deriveBlobKeys(fromBase64Url(generateKey()))
    const content = bytes('an image')
    const hash = await contentHash(content)
    const blob = await encryptBlob(keys, content)
    expect(await decryptBlob(keys, blob, hash)).toEqual(content)
    await expect(decryptBlob(keys, blob, await contentHash(bytes('another')))).rejects.toThrow()
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1
    await expect(decryptBlob(keys, blob, hash)).rejects.toThrow()
  })

  it('keeps blobs and frames apart', async () => {
    const key = generateKey()
    const keys = await deriveBlobKeys(fromBase64Url(key))
    const frames = await importKey(key)
    const content = bytes('an image')
    await expect(decrypt(frames, await encryptBlob(keys, content))).rejects.toThrow()
    await expect(
      decryptBlob(keys, await encrypt(frames, content), await contentHash(content)),
    ).rejects.toThrow()
  })
})
