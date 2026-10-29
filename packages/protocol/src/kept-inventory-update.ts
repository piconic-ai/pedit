import { concat, utf8 } from './access-crypto.ts'
import { MAX_KEPT_RECORD_PAYLOAD } from './kept-record.ts'
import { checkKeptTextUpdate } from './kept-text-schema.ts'

const DOMAIN = utf8.encode('pedit/v6/inventory-text-update\0')
const PATH = /^assets\/[0-9a-f]{32}\.(?:png|jpg|gif|webp)$(?![\s\S])/
export const MAX_INVENTORY_PATHS = 1024
export type KeptInventoryUpdate = { update: Uint8Array; additions: string[] }
const bad = () => new Error('invalid inventory text update')
const validPaths = (paths: readonly string[]) =>
  paths.length <= MAX_INVENTORY_PATHS &&
  paths.every((p, i) => PATH.test(p) && (i === 0 || (paths[i - 1] ?? '') < p))
function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n)
  return b
}
export function encodeKeptInventoryUpdate(value: KeptInventoryUpdate): Uint8Array {
  if (value.update.length > MAX_KEPT_RECORD_PAYLOAD || value.additions.length > MAX_INVENTORY_PATHS)
    throw bad()
  const update = Uint8Array.from(value.update)
  const paths = [...value.additions]
  if (!checkKeptTextUpdate(update) || !validPaths(paths)) throw bad()
  const encoded = paths.map((path) => utf8.encode(path))
  const size = DOMAIN.length + 1 + 8 + update.length + encoded.reduce((n, p) => n + 4 + p.length, 0)
  if (size > MAX_KEPT_RECORD_PAYLOAD) throw bad()
  return concat(
    DOMAIN,
    Uint8Array.of(0),
    u32(update.length),
    update,
    u32(paths.length),
    ...encoded.flatMap((p) => [u32(p.length), p]),
  )
}
export function decodeKeptInventoryUpdate(input: Uint8Array): KeptInventoryUpdate {
  if (input.length > MAX_KEPT_RECORD_PAYLOAD) throw bad()
  const data = Uint8Array.from(input)
  if (
    data.length > MAX_KEPT_RECORD_PAYLOAD ||
    data.length < DOMAIN.length + 9 ||
    !DOMAIN.every((b, i) => data[i] === b) ||
    data[DOMAIN.length] !== 0
  )
    throw bad()
  const view = new DataView(data.buffer)
  let at = DOMAIN.length + 1
  const readLength = () => {
    if (data.length - at < 4) throw bad()
    const n = view.getUint32(at)
    at += 4
    return n
  }
  const take = (n: number) => {
    if (n > data.length - at) throw bad()
    const b = data.slice(at, at + n)
    at += n
    return b
  }
  const update = take(readLength())
  const n = readLength()
  if (n > MAX_INVENTORY_PATHS) throw bad()
  const additions: string[] = []
  try {
    for (let i = 0; i < n; i++)
      additions.push(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(take(readLength())),
      )
  } catch {
    throw bad()
  }
  if (at !== data.length || !checkKeptTextUpdate(update) || !validPaths(additions)) throw bad()
  return { update, additions }
}
