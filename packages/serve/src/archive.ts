import { gunzipSync, inflateRawSync } from 'node:zlib'

/** The most a pedit binary may be after unpacking. */
export const MAX_BINARY_SIZE = 256 << 20

function fail(message: string): never {
  throw new Error(message)
}

const cstr = (b: Buffer) => b.toString('latin1').replace(/\0[\s\S]*$/, '')

/** One ustar header: the entry's own name (only when it has no prefix), size and type. */
function tarHeader(h: Buffer): { name: string; size: number; type: string } {
  const sizeField = h.subarray(124, 136)
  if ((sizeField[0] ?? 0) & 0x80) fail('unsupported tar size encoding')
  const size = Number.parseInt(cstr(sizeField).trim() || '0', 8)
  if (!Number.isSafeInteger(size) || size < 0) fail('bad tar header')
  // Only a header whose own name is the whole path: no ustar prefix, no pax or GNU long name.
  const name = cstr(h.subarray(345, 500)) === '' ? cstr(h.subarray(0, 100)) : ''
  return { name, size, type: String.fromCharCode(h[156] ?? 0) }
}

/** The regular file called `name` at the root of a tar.gz, or undefined. Nothing else is read. */
export function tarGzEntry(
  archive: Buffer,
  name: string,
  max = MAX_BINARY_SIZE,
): Buffer | undefined {
  // Headers and padding add little; the cap bounds what a gzip bomb can expand to.
  const tar = gunzipSync(archive, { maxOutputLength: max + (16 << 20) })
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512)
    if (h.every((b) => b === 0)) return undefined
    const e = tarHeader(h)
    const start = off + 512
    if (start + e.size > tar.length) fail('truncated tar archive')
    if (e.name === name && (e.type === '0' || e.type === '\0')) {
      if (e.size > max) fail(`${name} is larger than ${max} bytes`)
      return Buffer.from(tar.subarray(start, start + e.size))
    }
    off = start + Math.ceil(e.size / 512) * 512
  }
  return undefined
}

/** Where the zip's central directory starts and how many entries it has. */
function zipDirectory(zip: Buffer): { at: number; count: number } {
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) !== 0x06054b50) continue
    const count = zip.readUInt16LE(i + 10)
    const at = zip.readUInt32LE(i + 16)
    if (count === 0xffff || at === 0xffffffff) fail('zip64 archives are not supported')
    return { at, count }
  }
  return fail('not a zip archive')
}

interface ZipEntry {
  name: string
  regular: boolean
  flags: number
  method: number
  csize: number
  usize: number
  local: number
  next: number
}

/** The central directory record at `p`. */
function zipRecord(zip: Buffer, p: number): ZipEntry {
  if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) fail('bad zip directory')
  const nameLen = zip.readUInt16LE(p + 28)
  const name = zip.toString('utf8', p + 46, p + 46 + nameLen)
  const madeBy = zip.readUInt16LE(p + 4)
  const mode = zip.readUInt32LE(p + 38) >>> 16
  // Unix-made zips carry the file type in the mode; others only mark directories by a trailing slash.
  const unixMode = madeBy >> 8 === 3 && mode !== 0
  return {
    name,
    regular: unixMode ? (mode & 0o170000) === 0o100000 : !name.endsWith('/'),
    flags: zip.readUInt16LE(p + 8),
    method: zip.readUInt16LE(p + 10),
    csize: zip.readUInt32LE(p + 20),
    usize: zip.readUInt32LE(p + 24),
    local: zip.readUInt32LE(p + 42),
    next: p + 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32),
  }
}

/** The contents of one entry, stored or deflated, capped at `max`. */
function zipData(zip: Buffer, e: ZipEntry, max: number): Buffer {
  if (e.flags & 1) fail('the zip entry is encrypted')
  if (e.usize > max) fail(`${e.name} is larger than ${max} bytes`)
  if (e.local + 30 > zip.length || zip.readUInt32LE(e.local) !== 0x04034b50) fail('bad zip entry')
  const dataAt = e.local + 30 + zip.readUInt16LE(e.local + 26) + zip.readUInt16LE(e.local + 28)
  const data = zip.subarray(dataAt, dataAt + e.csize)
  if (data.length !== e.csize) fail('truncated zip archive')
  if (e.method !== 0 && e.method !== 8) fail('unsupported zip compression')
  const out = e.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: max })
  if (out.length !== e.usize) fail('bad zip entry size')
  return out
}

/** The regular file called `name` in a zip, or undefined. Reads the central directory only. */
export function zipEntry(zip: Buffer, name: string, max = MAX_BINARY_SIZE): Buffer | undefined {
  const dir = zipDirectory(zip)
  for (let n = 0, p = dir.at; n < dir.count; n++) {
    const e = zipRecord(zip, p)
    if (e.name === name && e.regular) return zipData(zip, e, max)
    p = e.next
  }
  return undefined
}
