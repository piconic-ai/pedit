import { describe, expect, it } from 'vitest'
// Written by the Go side (internal/protocol/files_test.go), so both encode the same.
import vectors from '../../testdata/files-vectors.json'
import {
  decodeFiles,
  encodeFileDoc,
  encodeManifest,
  type FileEntry,
  MAX_FILE_ID,
  MAX_FILES,
  MessageType,
  UnknownFilesKindError,
  UnknownMessageTypeError,
} from '../src/index.ts'

const hex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)))
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

// Encodes a manifest without checking it, as a hostile peer would.
function rawManifest(files: FileEntry[]): Uint8Array {
  const utf8 = new TextEncoder()
  const out: number[] = [0]
  const uint = (v: number) => {
    while (v >= 0x80) {
      out.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    out.push(v)
  }
  const bytes = (s: string | Uint8Array) => {
    const b = typeof s === 'string' ? utf8.encode(s) : s
    uint(b.length)
    out.push(...b)
  }
  uint(files.length)
  for (const f of files) {
    uint(f.id)
    bytes(f.path)
    bytes(f.format)
  }
  return new Uint8Array(out)
}

describe('files messages', () => {
  it('match the Go implementation', () => {
    expect(toHex(encodeManifest(vectors.manifest.files))).toBe(vectors.manifest.payload)
    expect(decodeFiles(hex(vectors.manifest.payload))).toEqual({
      kind: 'manifest',
      files: vectors.manifest.files,
    })
    expect(vectors.docs.length).toBeGreaterThan(0)
    for (const d of vectors.docs) {
      const type = d.type as MessageType
      expect(toHex(encodeFileDoc(d.file, type, hex(d.inner)))).toBe(d.payload)
      expect(decodeFiles(hex(d.payload))).toEqual({
        kind: 'doc',
        file: d.file,
        type,
        payload: hex(d.inner),
      })
    }
  })

  it('refuses a manifest a peer must not trust', () => {
    const f = (id: number, path: string, format = 'text') => ({ id, path, format })
    const tooMany = Array.from({ length: MAX_FILES + 1 }, (_, i) => f(i, `f${i}.md`))
    for (const files of [
      [f(1, '../x.md')],
      [f(1, '/etc/passwd')],
      [f(1, 'a‮b.md')],
      [f(1, 'a.md'), f(1, 'b.md')],
      [f(1, 'a.md'), f(2, 'a.md')],
      [f(MAX_FILE_ID + 1, 'a.md')],
      [f(1, 'a.md', '')],
      [f(1, 'a.md', 'Text/../x')],
      tooMany,
    ]) {
      expect(() => encodeManifest(files)).toThrow()
      expect(() => decodeFiles(rawManifest(files))).toThrow()
    }
  })

  it('keeps a leading BOM in a path, as Go does', () => {
    const files = [
      { id: 1, path: '\uFEFFagenda.md', format: 'text' },
      { id: 2, path: 'agenda.md', format: 'text' },
    ]
    expect(decodeFiles(encodeManifest(files))).toEqual({ kind: 'manifest', files })
  })

  it('carries only sync, attachment and canvas messages about a file', () => {
    // File 0 is the room's own doc, synced with plain messages.
    expect(() => encodeFileDoc(0, MessageType.Sync, new Uint8Array())).toThrow()
    expect(() => decodeFiles(new Uint8Array([1, 0, MessageType.Sync, 0]))).toThrow()
    for (const type of [MessageType.Awareness, MessageType.Files]) {
      expect(() => encodeFileDoc(1, type, new Uint8Array())).toThrow()
      expect(() => decodeFiles(new Uint8Array([1, 1, type, 0]))).toThrow()
    }
    // A type from a newer peer is skipped, like at the top level.
    expect(() => decodeFiles(new Uint8Array([1, 1, 9, 0]))).toThrow(UnknownMessageTypeError)
    expect(() => decodeFiles(new Uint8Array([9]))).toThrow(UnknownFilesKindError)
  })

  it('refuses malformed payloads', () => {
    const good = encodeManifest([{ id: 1, path: 'a.md', format: 'text' }])
    for (const payload of [
      new Uint8Array(),
      good.subarray(0, good.length - 1),
      new Uint8Array([...good, 0]),
      new Uint8Array([1]),
      new Uint8Array([1, 1]),
    ]) {
      expect(() => decodeFiles(payload)).toThrow()
    }
    const badUtf8 = rawManifest([{ id: 1, path: 'a.md', format: 'text' }])
    badUtf8[4] = 0xff // the "a" of the path
    expect(() => decodeFiles(badUtf8)).toThrow()
  })
})
