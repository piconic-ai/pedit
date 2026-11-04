import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { deflateRawSync, gzipSync } from 'node:zlib'

export interface Entry {
  name: string
  data: Buffer | string
  type?: string // tar typeflag
  deflate?: boolean
}

function crc32(b: Buffer): number {
  let c = ~0
  for (const x of b) {
    c ^= x
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

export function tarGz(entries: Entry[]): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    const data = Buffer.from(e.data)
    const h = Buffer.alloc(512)
    h.write(e.name, 0)
    h.write('0000755\0', 100)
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    h.write(e.type ?? '0', 156)
    h.write('ustar\0', 257)
    h.fill(' ', 148, 156)
    const sum = h.reduce((a, b) => a + b, 0)
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(parts))
}

export function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let off = 0
  for (const e of entries) {
    const raw = Buffer.from(e.data)
    const body = e.deflate ? deflateRawSync(raw) : raw
    const name = Buffer.from(e.name)
    const l = Buffer.alloc(30)
    l.writeUInt32LE(0x04034b50, 0)
    l.writeUInt16LE(20, 4)
    l.writeUInt16LE(e.deflate ? 8 : 0, 8)
    l.writeUInt32LE(crc32(raw), 14)
    l.writeUInt32LE(body.length, 18)
    l.writeUInt32LE(raw.length, 22)
    l.writeUInt16LE(name.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt16LE(e.deflate ? 8 : 0, 10)
    c.writeUInt32LE(crc32(raw), 16)
    c.writeUInt32LE(body.length, 20)
    c.writeUInt32LE(raw.length, 24)
    c.writeUInt16LE(name.length, 28)
    c.writeUInt32LE(off, 42)
    locals.push(l, name, body)
    central.push(c, name)
    off += 30 + name.length + body.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(off, 16)
  return Buffer.concat([...locals, cd, end])
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

export interface FakeRelease {
  url: string
  /** Paths requested, in order. */
  hits: string[]
  /** path -> body, or a status number. */
  routes: Map<string, Buffer | string | number>
  close: () => Promise<void>
}

/** A local server standing in for api.github.com and the release downloads. */
export async function fakeRelease(): Promise<FakeRelease> {
  const hits: string[] = []
  const routes = new Map<string, Buffer | string | number>()
  const server: Server = createServer((req, res) => {
    const path = req.url ?? ''
    hits.push(path)
    const r = routes.get(path)
    if (r === undefined || typeof r === 'number') {
      res.statusCode = r ?? 404
      return res.end()
    }
    res.end(r)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    routes,
    close: () => {
      server.closeAllConnections()
      return new Promise((r) => server.close(() => r()))
    },
  }
}
