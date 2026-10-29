import * as Y from 'yjs'
import { concat, utf8 } from './access-crypto.ts'
import { decodeFiles, encodeManifest, type FileEntry, metaPath } from './files.ts'
import { MAX_KEPT_CHECKPOINT_PAYLOAD } from './kept-checkpoint.ts'
import { checkKeptCommentsState } from './kept-comments-schema.ts'
import { KeptLedger } from './kept-ledger.ts'
import { decodeKeptLedger, encodeKeptLedger } from './kept-ledger-encoding.ts'
import { checkKeptTextState } from './kept-text-schema.ts'

const DOMAIN = utf8.encode('pedit/v6/text-checkpoint\0')
const ASSET = /assets\/[0-9a-f]{32}\.(?:png|jpg|gif|webp)/
export function validKeptUpdate(
  update: Uint8Array,
  content: boolean,
  allowAssets = false,
): boolean {
  if (content ? !checkKeptTextState(update) : !checkKeptCommentsState(update)) return false
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, update)
    return (
      !doc.store.pendingStructs &&
      !doc.store.pendingDs &&
      doc.getSubdocs().size === 0 &&
      (!content || allowAssets || !ASSET.test(doc.getText('content').toString()))
    )
  } catch {
    return false
  } finally {
    doc.destroy()
  }
}
export interface KeptTextPayload {
  manifest: FileEntry[]
  documents: Map<number, Uint8Array>
  ledger: KeptLedger
  attachments: 'none' | 'present' | 'unverified'
}
function metaId(files: FileEntry[]): number | null {
  if (files.length !== 2) return null
  const text = files.find((f) => f.id === 0 && f.format === 'text')
  const meta = files.find((f) => f.id > 0 && f.format === 'meta')
  return text && meta && meta.path === metaPath(text.path) ? meta.id : null
}
// Callers attest a complete attachment inventory and capture full Yjs updates
// consistently with the ledger. This function cannot verify either condition.
export function encodeKeptTextPayload(value: KeptTextPayload): Uint8Array {
  const id = metaId(value.manifest)
  if (value.attachments !== 'none' || id === null || value.documents.size !== 2)
    throw new Error('unsupported or invalid text checkpoint')
  const textInput = value.documents.get(0)
  const metaInput = value.documents.get(id)
  if (
    !textInput?.length ||
    !metaInput?.length ||
    textInput.length > MAX_KEPT_CHECKPOINT_PAYLOAD ||
    metaInput.length > MAX_KEPT_CHECKPOINT_PAYLOAD
  )
    throw new Error('unsupported or invalid text checkpoint')
  const text = new Uint8Array(textInput)
  const meta = new Uint8Array(metaInput)
  if (!validKeptUpdate(text, true) || !validKeptUpdate(meta, false))
    throw new Error('invalid Yjs state')
  const parts = [encodeManifest(value.manifest), text, meta, encodeKeptLedger(value.ledger)]
  let size = DOMAIN.length + 1 + 4 * parts.length
  for (const part of parts) {
    if (part.length > MAX_KEPT_CHECKPOINT_PAYLOAD - size)
      throw new Error('unsupported or invalid text checkpoint')
    size += part.length
  }
  const header = Uint8Array.of(0)
  const fields = parts.flatMap((part) => {
    const len = new Uint8Array(4)
    new DataView(len.buffer).setUint32(0, part.length)
    return [len, part]
  })
  return concat(DOMAIN, header, ...fields)
}
// Authenticate the enclosing checkpoint before parsing. The caller validates
// permissions and coordinates attachment and document recovery.
export function decodeKeptTextPayload(data: Uint8Array, ledgerLimit: number): KeptTextPayload {
  const bad = () => new Error('invalid text checkpoint')
  if (data.length > MAX_KEPT_CHECKPOINT_PAYLOAD || data.length < DOMAIN.length + 17) throw bad()
  data = new Uint8Array(data)
  if (!DOMAIN.every((v, i) => data[i] === v) || data[DOMAIN.length] !== 0) throw bad()
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let at = DOMAIN.length + 1
  const parts: Uint8Array[] = []
  for (let i = 0; i < 4; i++) {
    if (data.length - at < 4) throw bad()
    const size = view.getUint32(at)
    at += 4
    if (!size || size > data.length - at) throw bad()
    parts.push(data.slice(at, at + size))
    at += size
  }
  if (at !== data.length) throw bad()
  const [manifest, text, meta, ledger] = parts
  if (!manifest || !text || !meta || !ledger) throw bad()
  const parsed = decodeFiles(manifest)
  if (parsed.kind !== 'manifest') throw bad()
  const id = metaId(parsed.files)
  if (id === null || !same(manifest, encodeManifest(parsed.files))) throw bad()
  if (!validKeptUpdate(text, true) || !validKeptUpdate(meta, false)) throw bad()
  return {
    manifest: parsed.files,
    documents: new Map([
      [0, text],
      [id, meta],
    ]),
    ledger: decodeKeptLedger(ledgerLimit, ledger),
    attachments: 'none',
  }
}
function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
