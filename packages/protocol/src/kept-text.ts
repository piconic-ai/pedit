import * as decoding from 'lib0/decoding'
import * as Y from 'yjs'
import type { RoomKeys } from './access.ts'
import { decrypt, encrypt } from './cipher.ts'
import { type FileEntry, metaTarget } from './files.ts'
import { MAX_FRAME_BYTES } from './frame.ts'
import { checkMetaUpdate } from './meta.ts'
import { checkPath, MAX_PATH_BYTES } from './path.ts'

const DOMAIN = new TextEncoder().encode('pedit kept text v1\0')
const SNAPSHOT_DOMAIN = new TextEncoder().encode('pedit kept snapshot v1\0')
const BUNDLE_DOMAIN = new TextEncoder().encode('pedit kept files snapshot v1\0')
const FILE_DOMAIN = new TextEncoder().encode('pedit kept file update v1\0')
/** Text files in a kept room; the comments docs paired with them do not count. */
const MAX_KEPT_FILES = 64
/** Signs and encrypts one update of a doc as a kept entry; with `file`, it names the doc by its id. */
export async function sealKeptUpdate(
  keys: RoomKeys,
  id: number,
  update: Uint8Array,
  file = true,
): Promise<Uint8Array> {
  const signer = keys.signer
  if (signer?.access !== 'edit') throw new Error('edit link required')
  let payload = update
  if (file) {
    payload = new Uint8Array(4 + update.length)
    new DataView(payload.buffer).setUint32(0, id)
    payload.set(update, 4)
  }
  const message = join(file ? FILE_DOMAIN : DOMAIN, payload)
  const signature = new Uint8Array(
    await crypto.subtle.sign('Ed25519', signer.key, Uint8Array.from(message)),
  )
  return encrypt(keys.frameKey, join(message, signature))
}

/** Decrypts a kept entry or bundle and checks an editor signed it; returns the signed message. */
export async function openKeptFrame(keys: RoomKeys, ciphertext: Uint8Array): Promise<Uint8Array> {
  const plain = await decrypt(keys.frameKey, ciphertext)
  const message = plain.subarray(0, plain.length - 64)
  if (
    plain.length <= 64 ||
    !(await crypto.subtle.verify(
      'Ed25519',
      keys.editKey,
      Uint8Array.from(plain.subarray(plain.length - 64)),
      Uint8Array.from(message),
    ))
  )
    throw new Error('invalid kept signature')
  return message
}
export type FileUpdate = { id: number; update: Uint8Array }
export type BundleFile = FileUpdate & { path: string }
export type OpenedSnapshot =
  | { kind: 'bundle'; files: BundleFile[] }
  | { kind: 'legacy'; filename: string | null; update: Uint8Array }
/** Applies kept entries to a copy of `base`, skipping and counting those that do not hold. */
export function probeEntries(
  base: Y.Doc,
  entries: readonly Uint8Array[],
): { doc: Y.Doc; skipped: number } {
  let probe = copyDoc(base),
    skipped = 0
  const accepted: Uint8Array[] = []
  try {
    for (const update of entries) {
      try {
        const next = trial(probe, update)
        probe.destroy()
        probe = next
        accepted.push(update)
      } catch {
        skipped++
      }
    }
    while (incomplete(probe)) {
      const complete = accepted.filter((update) => integrated(probe, update))
      if (complete.length === accepted.length) complete.length = 0
      skipped += accepted.length - complete.length
      accepted.splice(0, accepted.length, ...complete)
      probe.destroy()
      probe = copyDoc(base)
      for (const update of accepted) Y.applyUpdate(probe, update)
    }
    return { doc: probe, skipped }
  } catch (error) {
    probe.destroy()
    throw error
  }
}

function payloadFor(message: Uint8Array, domain: Uint8Array): Uint8Array | undefined {
  return domain.every((byte, i) => message[i] === byte) ? message.slice(domain.length) : undefined
}
export function decodeUpdate(message: Uint8Array): FileUpdate {
  const payload = payloadFor(message, FILE_DOMAIN)
  if (payload) {
    if (payload.length <= 4) throw new Error('invalid kept file update')
    return {
      id: new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0),
      update: payload.slice(4),
    }
  }
  const legacy = payloadFor(message, DOMAIN)
  if (!legacy?.length) throw new Error('invalid kept domain')
  return { id: 0, update: legacy }
}
export function decodeSnapshot(message: Uint8Array): OpenedSnapshot {
  const bundle = payloadFor(message, BUNDLE_DOMAIN)
  if (bundle) return { kind: 'bundle', files: decodeBundle(bundle) }
  const payload = payloadFor(message, SNAPSHOT_DOMAIN)
  if (payload) {
    if (payload.length < 2) throw new Error('invalid kept snapshot')
    const size = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint16(0)
    if (size < 1 || size > 4096 || size >= payload.length - 2)
      throw new Error('invalid kept filename')
    const filename = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      payload.subarray(2, 2 + size),
    )
    if (filename === '.' || filename === '..' || /[/\\\0]/.test(filename))
      throw new Error('invalid kept filename')
    return { kind: 'legacy', filename, update: payload.slice(2 + size) }
  }
  const legacy = payloadFor(message, DOMAIN)
  if (!legacy?.length) throw new Error('invalid kept snapshot domain')
  return { kind: 'legacy', filename: null, update: legacy }
}
export function mergeSnapshot(base: Y.Doc, update: Uint8Array): void {
  const empty = declare(new Y.Doc(), kindOf(base) === 'comments')
  let snapshot: Y.Doc | undefined
  try {
    snapshot = trial(empty, update)
    if (incomplete(snapshot)) throw new Error('invalid kept snapshot')
    Y.applyUpdate(base, Y.encodeStateAsUpdate(snapshot))
  } finally {
    empty.destroy()
    snapshot?.destroy()
  }
}
function sameFiles(
  a: readonly Pick<FileEntry, 'id' | 'path'>[],
  b: readonly Pick<FileEntry, 'id' | 'path'>[],
): boolean {
  return (
    a.length === b.length && a.every((file, i) => file.id === b[i]?.id && file.path === b[i]?.path)
  )
}
function decodeBundle(payload: Uint8Array): BundleFile[] {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const count = view.getUint16(0),
    files: BundleFile[] = [],
    ids = new Set<number>(),
    paths = new Set<string>()
  if (count < 1 || count > 2 * MAX_KEPT_FILES) throw new Error('invalid kept file count')
  let at = 2
  for (let i = 0; i < count; i++) {
    const id = view.getUint32(at)
    at += 4
    const size = view.getUint16(at)
    at += 2
    if (size < 1 || size > MAX_PATH_BYTES || at + size > payload.length)
      throw new Error('invalid kept path')
    const path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      payload.subarray(at, at + size),
    )
    at += size
    const length = view.getUint32(at)
    at += 4
    if (
      (i === 0 && id !== 0) ||
      ids.has(id) ||
      paths.has(path) ||
      checkPath(path) ||
      length === 0 ||
      at + length > payload.length
    )
      throw new Error('invalid kept file')
    ids.add(id)
    paths.add(path)
    files.push({ id, path, update: payload.slice(at, at + length) })
    at += length
  }
  // The cap counts text files; their paired metadata docs come on top.
  if (files.filter((file) => metaTarget(file.path) === undefined).length > MAX_KEPT_FILES)
    throw new Error('invalid kept file count')
  if (at !== payload.length) throw new Error('invalid kept bundle trailing bytes')
  return files
}
function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length)
  result.set(a)
  result.set(b, a.length)
  return result
}
export function incomplete(doc: Y.Doc): boolean {
  return doc.store.pendingStructs !== null || doc.store.pendingDs !== null
}
/** A kept file's doc has one root: its text, or the comments paired with it. */
export function kindOf(doc: Y.Doc): 'content' | 'comments' {
  return doc.share.has('comments') ? 'comments' : 'content'
}
export function declare(doc: Y.Doc, comments: boolean): Y.Doc {
  if (comments) doc.getMap('comments')
  else doc.getText('content')
  return doc
}
function copyDoc(doc: Y.Doc): Y.Doc {
  const copy = declare(new Y.Doc(), kindOf(doc) === 'comments')
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}
export function trial(base: Y.Doc, update: Uint8Array): Y.Doc {
  // Anyone with the edit key may log an update: comments are checked as in a live room.
  const refusal = kindOf(base) === 'comments' ? checkMetaUpdate(base, update) : null
  if (refusal) throw new Error('invalid kept comments')
  const copy = copyDoc(base)
  try {
    const decoder = decoding.createDecoder(update)
    Y.readUpdate(decoder, copy)
    if (decoder.pos !== update.length || copy.share.size > 1) throw new Error('invalid kept text')
    return copy
  } catch (error) {
    copy.destroy()
    throw error
  }
}
function integrated(doc: Y.Doc, update: Uint8Array): boolean {
  return Y.snapshotContainsUpdate(Y.snapshot(doc), update)
}
