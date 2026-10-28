import * as decoding from 'lib0/decoding'
import { checkKeptSchema, type KeptSchemaReader } from './kept-schema.ts'

function item(r: KeptSchemaReader): void {
  const info = decoding.readUint8(r.decoder),
    ref = info & 31
  if ((info & 0x20) !== 0 || (ref !== 1 && ref !== 4)) throw new Error('invalid text item')
  if (info & 0x80) r.id()
  if (info & 0x40) r.id()
  if ((info & 0xc0) === 0 && (r.uint() !== 1 || r.str() !== 'content'))
    throw new Error('invalid root')
  const length = ref === 4 ? r.str().length : r.uint()
  if (length === 0 || length > Number.MAX_SAFE_INTEGER - r.clock)
    throw new Error('invalid text clock')
  r.clock += length
}
export function checkKeptTextState(input: Uint8Array): boolean {
  return checkKeptSchema(input, item, false)
}
