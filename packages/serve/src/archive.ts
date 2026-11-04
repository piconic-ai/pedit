import { gunzipSync, inflateRawSync } from 'node:zlib'

/** The most a pedit binary may be after unpacking. */
export const MAX_BINARY_SIZE = 256 << 20

function fail(message: string): never {
  throw new Error(message)
}

/** The regular file called `name` at the root of a tar.gz, or undefined. Nothing else is read. */
export function tarGzEntry(
  archive: Buffer,
  name: string,
  max = MAX_BINARY_SIZE,
): Buffer | undefined {
  // Headers and padding add little; the cap bounds what a gzip bomb can expand to.
  const tar = gunzipSync(archive, { maxOutputLength: max + (16 << 20) })
  const cstr = (b: Buffer) => b.toString('latin1').replace(/\0[\s\S]*$/, '')
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512)
    if (h.every((b) => b === 0)) return undefined
    const sizeField = h.subarray(124, 136)
    if ((sizeField[0] ?? 0) & 0x80) fail('unsupported tar size encoding')
    const size = Number.parseInt(cstr(sizeField).trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0) fail('bad tar header')
    const type = String.fromCharCode(h[156] ?? 0)
    const start = off + 512
    if (start + size > tar.length) fail('truncated tar archive')
    // Only a header whose own name is exactly `name`: no ustar prefix, no pax or GNU long name.
    const isRoot = cstr(h.subarray(0, 100)) === name && cstr(h.subarray(345, 500)) === ''
    if (isRoot && (type === '0' || type === '\0')) {
      if (size > max) fail(`${name} is larger than ${max} bytes`)
      return Buffer.from(tar.subarray(start, start + size))
    }
    off = start + Math.ceil(size / 512) * 512
  }
  return undefined
}

/** The regular file called `name` in a zip, or undefined. Reads the central directory only. */
export function zipEntry(zip: Buffer, name: string, max = MAX_BINARY_SIZE): Buffer | undefined {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) fail('not a zip archive')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || p === 0xffffffff) fail('zip64 archives are not supported')
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) fail('bad zip directory')
    const madeBy = zip.readUInt16LE(p + 4)
    const flags = zip.readUInt16LE(p + 8)
    const method = zip.readUInt16LE(p + 10)
    const csize = zip.readUInt32LE(p + 20)
    const usize = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const next = p + 46 + nameLen + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32)
    const mode = zip.readUInt32LE(p + 38) >>> 16
    const local = zip.readUInt32LE(p + 42)
    const entry = zip.toString('utf8', p + 46, p + 46 + nameLen)
    p = next
    // Unix-made zips carry the file type in the mode; others only mark directories by a trailing slash.
    const regular =
      madeBy >> 8 === 3 && mode !== 0 ? (mode & 0o170000) === 0o100000 : !entry.endsWith('/')
    if (entry !== name || !regular) continue
    if (flags & 1) fail('the zip entry is encrypted')
    if (usize > max) fail(`${name} is larger than ${max} bytes`)
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) fail('bad zip entry')
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(dataAt, dataAt + csize)
    if (data.length !== csize) fail('truncated zip archive')
    const out =
      method === 0
        ? Buffer.from(data)
        : method === 8
          ? inflateRawSync(data, { maxOutputLength: max })
          : fail('unsupported zip compression')
    if (out.length !== usize) fail('bad zip entry size')
    return out
  }
  return undefined
}
