import * as decoding from 'lib0/decoding'
import { MAX_FRAME_BYTES } from './frame.ts'

export class KeptSchemaReader {
  readonly decoder: decoding.Decoder
  work = 0
  advance(n: number): void {
    if (n > 1024 || this.work > 1024 - n) throw new Error('comments too large')
    this.work += n
  }
  constructor(readonly input: Uint8Array) {
    this.decoder = decoding.createDecoder(input)
  }
  remaining(): number {
    return this.input.length - this.decoder.pos
  }
  uint(): number {
    const start = this.decoder.pos
    const value = decoding.readVarUint(this.decoder)
    if (
      !Number.isSafeInteger(value) ||
      (this.decoder.pos - start > 1 && this.input[this.decoder.pos - 1] === 0)
    )
      throw new Error('invalid integer')
    return value
  }
  id(): void {
    this.uint()
    this.uint()
  }
  str(): string {
    const n = this.uint()
    if (n > this.remaining()) throw new Error('truncated string')
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      decoding.readUint8Array(this.decoder, n),
    )
  }
  count(nonzero: boolean): number {
    const n = this.uint()
    if ((nonzero && n === 0) || n > this.remaining()) throw new Error('invalid count')
    return n
  }
  private signed(): void {
    const start = this.decoder.pos
    const n = decoding.readVarInt(this.decoder)
    if (
      !Number.isSafeInteger(n) ||
      Object.is(n, -0) ||
      (this.decoder.pos - start > 1 && this.input[this.decoder.pos - 1] === 0)
    )
      throw new Error('invalid integer')
  }
  private collection(depth: number, tag: number): void {
    const n = this.count(false)
    if (n > 100_000) throw new Error('too many values')
    for (let i = 0; i < n; i++) {
      if (tag === 118 && this.str() === '__proto__') throw new Error('invalid key')
      this.any(depth + 1)
    }
  }
  any(depth: number): void {
    if (depth > 100 || this.remaining() < 1) throw new Error('invalid value')
    const tag = decoding.readUint8(this.decoder)
    switch (tag) {
      case 126:
      case 121:
      case 120:
        return
      case 125:
        this.signed()
        return
      case 124:
      case 123: {
        const n =
          tag === 124 ? decoding.readFloat32(this.decoder) : decoding.readFloat64(this.decoder)
        if (!Number.isFinite(n) || Object.is(n, -0)) throw new Error('invalid float')
        return
      }
      case 119:
        this.str()
        return
      case 116:
        decoding.readUint8Array(this.decoder, this.count(false))
        return
      case 117:
      case 118:
        this.collection(depth, tag)
        return
      default:
        throw new Error('unknown value')
    }
  }
}
function client(r: KeptSchemaReader, seen: Set<number>, item: (r: KeptSchemaReader) => void): void {
  const count = r.count(true),
    id = r.uint()
  if (seen.has(id) || r.uint() !== 0) throw new Error('invalid client')
  seen.add(id)
  for (let i = 0; i < count; i++) item(r)
}
function deletions(r: KeptSchemaReader): number {
  const n = r.count(false)
  for (let i = 0; i < n; i++) {
    r.uint()
    const count = r.count(false)
    for (let j = 0; j < count; j++) r.id()
  }
  return n
}
export function checkKeptSchema(
  input: Uint8Array,
  item: (r: KeptSchemaReader) => void,
  comments: boolean,
): boolean {
  if (!input.length || input.length > MAX_FRAME_BYTES) return false
  try {
    const r = new KeptSchemaReader(input),
      clients = r.count(false),
      seen = new Set<number>()
    for (let i = 0; i < clients; i++) client(r, seen, item)
    const deleted = deletions(r)
    return (
      r.remaining() === 0 &&
      (!comments ||
        input.length + 112 * r.work + 32 * (clients + deleted) + 2 <= MAX_FRAME_BYTES - 4096)
    )
  } catch {
    return false
  }
}
