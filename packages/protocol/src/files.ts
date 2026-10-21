import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { decodeMessage, encodeMessage, MessageType } from './message.ts'
import { checkPath } from './path.ts'

/**
 * Files messages carry the files of a room that shares several (#113). Each
 * file is a Y.Doc of its own: one doc for all would put every file under the
 * one frame its state is sent in. File 0 is the room's own doc, synced as in
 * a room that shares one file: a room can start with one file and add more,
 * and older peers, which skip these messages, go on editing file 0.
 *
 * - manifest: the host's list of the room's files, which replaces any list
 *   sent before
 * - doc: a sync, attachment or canvas message, as it would be sent in a room
 *   that shares one file, for the file with this id (never 0)
 *
 * The host gives each file an id that it never reuses in the room, and only
 * ever routes a message by the id it carries: a path is for people to read.
 */
export type FilesMessage =
  | { kind: 'manifest'; files: FileEntry[] }
  | { kind: 'doc'; file: number; type: FileMessageType; payload: Uint8Array }

export interface FileEntry {
  id: number
  path: string
  /** `text`, `canvas`, `meta`, or a format a newer host shares, which a peer leaves out. */
  format: string
}

/**
 * The format of a file's metadata, such as its comments (#121): a doc the
 * host keeps under .pedit/meta/. Its path is `metaPath` of its file's path.
 */
export const META_FORMAT = 'meta'

const META_PREFIX = '.pedit/meta/'
const META_SUFFIX = '.json'

/**
 * The path of the metadata of the file at `path`, in a manifest. It pairs the
 * two: it is not where the host keeps the metadata on disk.
 */
export const metaPath = (path: string): string => META_PREFIX + path + META_SUFFIX

/**
 * Pairs the files of a manifest with their metadata: maps the id of a file to
 * the id of the `meta` entry whose path is `metaPath` of the file's. A `meta`
 * entry that names no file, or names another `meta` entry, pairs with nothing.
 */
export function metaFiles(files: FileEntry[]): Map<number, number> {
  const byPath = new Map(files.map((f) => [f.path, f]))
  const pairs = new Map<number, number>()
  for (const m of files) {
    const target = metaTarget(m.path)
    if (m.format !== META_FORMAT || target === undefined) continue
    const file = byPath.get(target)
    if (file && file.format !== META_FORMAT) pairs.set(file.id, m.id)
  }
  return pairs
}

/** The path whose `metaPath` is `path`, if it is one. */
const metaTarget = (path: string): string | undefined =>
  path.startsWith(META_PREFIX) && path.endsWith(META_SUFFIX)
    ? path.slice(META_PREFIX.length, -META_SUFFIX.length)
    : undefined

export type FileMessageType =
  | typeof MessageType.Sync
  | typeof MessageType.Attachment
  | typeof MessageType.Canvas

const KIND = { manifest: 0, doc: 1 } as const

/** The host shares fewer files; this only bounds what a peer accepts. */
export const MAX_FILES = 64
export const MAX_FILE_ID = 2 ** 32 - 1

const FORMAT = /^[a-z][a-z0-9-]{0,31}$/
const utf8 = new TextEncoder()
// ignoreBOM keeps a leading U+FEFF, as Go does: it is part of the name.
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function encodeManifest(files: FileEntry[]): Uint8Array {
  validateManifest(files)
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, KIND.manifest)
  encoding.writeVarUint(encoder, files.length)
  for (const f of files) {
    encoding.writeVarUint(encoder, f.id)
    encoding.writeVarUint8Array(encoder, utf8.encode(f.path))
    encoding.writeVarUint8Array(encoder, utf8.encode(f.format))
  }
  return encoding.toUint8Array(encoder)
}

/** Wraps a sync, attachment or canvas payload for one file. */
export function encodeFileDoc(file: number, type: MessageType, payload: Uint8Array): Uint8Array {
  validateDoc(file, type)
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, KIND.doc)
  encoding.writeVarUint(encoder, file)
  encoding.writeUint8Array(encoder, encodeMessage(type, payload))
  return encoding.toUint8Array(encoder)
}

/**
 * A files kind this version does not know, from a newer peer. Clients skip
 * such messages instead of reporting them.
 */
export class UnknownFilesKindError extends Error {
  // Not a parameter property: Node.js strips types but cannot run those.
  readonly filesKind: number

  constructor(filesKind: number) {
    super(`unknown files kind: ${filesKind}`)
    this.name = 'UnknownFilesKindError'
    this.filesKind = filesKind
  }
}

/**
 * Throws on malformed payloads, UnknownFilesKindError on kinds this version
 * does not know, and UnknownMessageTypeError on a doc message of a type it
 * does not know.
 */
export function decodeFiles(payload: Uint8Array): FilesMessage {
  // lib0 can read past the end without complaint, so check around every read.
  const decoder = decoding.createDecoder(payload)
  const read = <T>(fn: () => T): T => {
    if (decoder.pos >= payload.length) throw new Error('truncated files message')
    const value = fn()
    if (decoder.pos > payload.length) throw new Error('truncated files message')
    return value
  }
  const uint = () => read(() => decoding.readVarUint(decoder))
  const str = () => fatalUtf8.decode(read(() => decoding.readVarUint8Array(decoder)))

  const kind = uint()
  switch (kind) {
    case KIND.manifest: {
      const count = uint()
      if (count > MAX_FILES) throw new Error('too many files')
      const files: FileEntry[] = []
      for (let i = 0; i < count; i++) files.push({ id: uint(), path: str(), format: str() })
      if (decoder.pos !== payload.length) throw new Error('trailing bytes in files message')
      validateManifest(files)
      return { kind: 'manifest', files }
    }
    case KIND.doc: {
      const file = uint()
      const { type, payload: inner } = decodeMessage(payload.subarray(decoder.pos))
      validateDoc(file, type)
      return { kind: 'doc', file, type: type as FileMessageType, payload: inner }
    }
    default:
      throw new UnknownFilesKindError(kind)
  }
}

function validateManifest(files: FileEntry[]): void {
  if (files.length > MAX_FILES) throw new Error('too many files')
  const ids = new Set<number>()
  const paths = new Set<string>()
  for (const f of files) {
    if (!validId(f.id) || ids.has(f.id)) throw new Error(`invalid file id ${f.id}`)
    const problem = checkPath(f.path)
    if (problem) throw new Error(`file ${f.id}: unsafe path: ${problem}`)
    if (paths.has(f.path)) throw new Error(`file ${f.id}: path listed twice`)
    if (!FORMAT.test(f.format)) throw new Error(`file ${f.id}: invalid format`)
    ids.add(f.id)
    paths.add(f.path)
  }
}

function validateDoc(file: number, type: MessageType): void {
  if (file === 0 || !validId(file)) throw new Error(`invalid file id ${file}`)
  if (type !== MessageType.Sync && type !== MessageType.Attachment && type !== MessageType.Canvas) {
    throw new Error(`a ${type} message cannot be about a file`)
  }
}

const validId = (id: number) => Number.isInteger(id) && id >= 0 && id <= MAX_FILE_ID
