import * as Y from 'yjs'
import { concat, utf8 } from './access-crypto.ts'
import { decodeFiles, encodeManifest, type FileEntry, metaFiles } from './files.ts'
import { MAX_KEPT_CHECKPOINT_PAYLOAD } from './kept-checkpoint.ts'
import { type KeptLedger } from './kept-ledger.ts'
import { decodeKeptLedger, encodeKeptLedger } from './kept-ledger-encoding.ts'
import { validKeptUpdate } from './kept-text-payload.ts'

const DOMAIN = utf8.encode('pedit/v6/multi-checkpoint\0')
const ASSET = /assets\/[0-9a-f]{32}\.(?:png|jpg|gif|webp)/g
const ASSET_PATH = /^assets\/[0-9a-f]{32}\.(?:png|jpg|gif|webp)$(?![\s\S])/
const MAX_ATTACHMENTS = 1024
const bad = () => new Error('invalid multi-file checkpoint')

// Capturing all updates consistently with the ledger, and checking that the
// complete inventory's blobs exist, is the caller's responsibility.
export interface KeptMultiPayload {
  manifest: FileEntry[]
  documents: Map<number, Uint8Array>
  attachments: string[]
  ledger: KeptLedger
}

function validateManifest(value: KeptMultiPayload): void {
  const { manifest, documents, attachments } = value
  if (
    !manifest.length ||
    manifest.length !== documents.size ||
    attachments.length > MAX_ATTACHMENTS
  )
    throw bad()
  const pairs = metaFiles(manifest)
  let texts = 0
  let metas = 0
  let root = false
  for (const file of manifest) {
    if (file.format === 'text') {
      texts++
      if (file.id === 0) root = true
      if (!pairs.has(file.id)) throw bad()
    } else if (file.format === 'meta') metas++
    else throw bad()
    const update = documents.get(file.id)
    if (
      !update?.length ||
      update.length > MAX_KEPT_CHECKPOINT_PAYLOAD ||
      !validKeptUpdate(update, file.format === 'text', true)
    )
      throw bad()
  }
  if (!root || texts !== metas) throw bad()
}

function validateAttachments(value: KeptMultiPayload): void {
  const { manifest, documents, attachments } = value
  for (let i = 0; i < attachments.length; i++) {
    const path = attachments[i]
    if (!path || !ASSET_PATH.test(path) || (i > 0 && (attachments[i - 1] ?? '') >= path))
      throw bad()
  }
  const available = new Set(attachments)
  for (const file of manifest) {
    if (file.format !== 'text') continue
    const update = documents.get(file.id)
    if (!update) throw bad()
    const doc = new Y.Doc()
    try {
      Y.applyUpdate(doc, update)
      for (const path of doc.getText('content').toString().match(ASSET) ?? [])
        if (!available.has(path)) throw bad()
    } finally {
      doc.destroy()
    }
  }
}

function part(bytes: Uint8Array): Uint8Array {
  if (!bytes.length) throw bad()
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, bytes.length)
  return concat(length, bytes)
}

export function encodeKeptMultiPayload(value: KeptMultiPayload): Uint8Array {
  const manifest = encodeManifest(value.manifest)
  validateManifest(value)
  validateAttachments(value)
  const parts = [DOMAIN, Uint8Array.of(0), part(manifest)]
  for (const file of value.manifest) {
    const update = value.documents.get(file.id)
    if (!update) throw bad()
    parts.push(part(update))
  }
  const count = new Uint8Array(4)
  new DataView(count.buffer).setUint32(0, value.attachments.length)
  parts.push(count)
  for (const path of value.attachments) parts.push(part(utf8.encode(path)))
  parts.push(part(encodeKeptLedger(value.ledger)))
  if (parts.reduce((size, bytes) => size + bytes.length, 0) > MAX_KEPT_CHECKPOINT_PAYLOAD)
    throw bad()
  return concat(...parts)
}

export function decodeKeptMultiPayload(input: Uint8Array, ledgerLimit: number): KeptMultiPayload {
  if (input.length > MAX_KEPT_CHECKPOINT_PAYLOAD || input.length < DOMAIN.length + 1) throw bad()
  const data = new Uint8Array(input)
  if (!DOMAIN.every((v, i) => data[i] === v) || data[DOMAIN.length] !== 0) throw bad()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let at = DOMAIN.length + 1
  const read = (): Uint8Array => {
    if (data.length - at < 4) throw bad()
    const size = view.getUint32(at)
    at += 4
    if (!size || size > data.length - at) throw bad()
    const value = data.slice(at, at + size)
    at += size
    return value
  }
  const manifestBytes = read()
  const decoded = decodeFiles(manifestBytes)
  if (decoded.kind !== 'manifest') throw bad()
  const canonical = encodeManifest(decoded.files)
  if (
    canonical.length !== manifestBytes.length ||
    !canonical.every((v, i) => v === manifestBytes[i])
  )
    throw bad()
  const documents = new Map<number, Uint8Array>()
  for (const file of decoded.files) documents.set(file.id, read())
  if (data.length - at < 4) throw bad()
  const count = view.getUint32(at)
  at += 4
  if (count > MAX_ATTACHMENTS) throw bad()
  const attachments: string[] = []
  for (let i = 0; i < count; i++)
    attachments.push(new TextDecoder('utf-8', { fatal: true }).decode(read()))
  const ledger = decodeKeptLedger(ledgerLimit, read())
  if (at !== data.length) throw bad()
  const result = { manifest: decoded.files, documents, attachments, ledger }
  validateManifest(result)
  validateAttachments(result)
  return result
}
