import * as decoding from 'lib0/decoding'
import { checkKeptSchema, type KeptSchemaReader } from './kept-schema.ts'

function parent(r: KeptSchemaReader, info: number): void {
  if (info & 0x80) {
    r.id()
    return
  }
  const named = r.uint()
  if (named > 1) throw new Error('invalid parent')
  if (named === 1) {
    if (r.str() !== 'comments') throw new Error('invalid root')
  } else r.id()
  if (!(info & 0x20) || new TextEncoder().encode(r.str()).length > 64)
    throw new Error('invalid key')
}
function item(r: KeptSchemaReader): void {
  const info = decoding.readUint8(r.decoder),
    ref = info & 31
  if (ref === 0) {
    const n = r.uint()
    if (!n) throw new Error('empty gc')
    r.advance(n)
    return
  }
  if ((ref !== 1 && ref !== 7 && ref !== 8) || info & 0x40) throw new Error('invalid item')
  parent(r, info)
  if (ref === 1) {
    const n = r.uint()
    if (!n) throw new Error('empty deleted content')
    r.advance(n)
  } else if (ref === 7) {
    if (r.uint() !== 1) throw new Error('invalid type')
    r.advance(1)
  } else {
    const n = r.count(true)
    r.advance(n)
    for (let i = 0; i < n; i++) r.any(0)
  }
}
// Structural checks only: applying state must also reject pending dependencies and resource excess.
export function checkKeptCommentsState(input: Uint8Array): boolean {
  return checkKeptSchema(input, item, true)
}
