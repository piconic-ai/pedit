import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  CLOSE,
  DATA,
  EVENT,
  encodeFrame,
  FrameError,
  FrameParser,
  MAX_FRAME,
  OPEN,
  Streams,
} from '../src/bridge.ts'
import { sleep } from './helpers.ts'

/** A Streams over a fake child: what the app writes to stdin is parsed back into frames. */
function fake() {
  const stdin = new PassThrough()
  const written: { kind: number; stream: number; payload: Buffer }[] = []
  stdin.on('data', (d: Buffer) => {
    for (let b = d; b.length; b = b.subarray(9 + b.readUInt32BE(5)))
      written.push({
        kind: b[0] as number,
        stream: b.readUInt32BE(1),
        payload: b.subarray(9, 9 + b.readUInt32BE(5)),
      })
  })
  return { streams: new Streams(stdin), written, stdin }
}

const data = (stream: number, ...bytes: number[]) => ({
  kind: DATA,
  stream,
  payload: Buffer.from(bytes),
})

describe('Streams', () => {
  it('opens streams with rising ids and the role in the open frame', async () => {
    const { streams, written } = fake()
    streams.open('edit', () => {})
    streams.open('read', () => {})
    await sleep(20)
    expect(written.map((f) => [f.kind, f.stream, [...f.payload]])).toEqual([
      [OPEN, 1, [0]],
      [OPEN, 2, [1]],
    ])
  })

  it('keeps frames that arrive before onframe is set', () => {
    const { streams } = fake()
    const bridge = streams.open('edit', () => {})
    streams.deliver(data(1, 1, 2, 3))
    streams.deliver(data(1, 4))
    const got: number[][] = []
    bridge.onframe = (f) => got.push([...f])
    expect(got).toEqual([[1, 2, 3], [4]])
  })

  it('keeps the close that arrives before onclose is set, and frees the slot once', () => {
    let gone = 0
    const { streams } = fake()
    const bridge = streams.open('read', () => gone++)
    const payload = Buffer.concat([Buffer.from([0x0f, 0xa3]), Buffer.from('read-only connection')])
    streams.deliver({ kind: CLOSE, stream: 1, payload })
    streams.abort()
    const seen: [string, number | undefined][] = []
    bridge.onclose = (reason, code) => seen.push([reason, code])
    expect(seen).toEqual([['read-only connection', 4003]])
    expect(gone).toBe(1)
  })

  it('reports 1005 for a close without a code and 1006 when the child is gone', () => {
    const { streams } = fake()
    const a = streams.open('edit', () => {})
    const b = streams.open('edit', () => {})
    const codes: (number | undefined)[] = []
    a.onclose = (_, c) => codes.push(c)
    b.onclose = (_, c) => codes.push(c)
    streams.deliver({ kind: CLOSE, stream: 1, payload: Buffer.alloc(0) })
    streams.abort()
    expect(codes).toEqual([1005, 1006])
  })

  it('sends a close frame on close, and ignores what pedit sends after', async () => {
    const { streams, written } = fake()
    let seen = 0
    const bridge = streams.open('edit', () => {})
    bridge.onframe = () => seen++
    bridge.close()
    bridge.close()
    streams.deliver(data(1, 9))
    await sleep(20)
    expect(seen).toBe(0)
    expect(written.filter((f) => f.kind === CLOSE)).toHaveLength(1)
  })

  it('closes a frame over 16 MiB with 1009 and does not send it', async () => {
    const { streams, written } = fake()
    const bridge = streams.open('edit', () => {})
    let code: number | undefined
    bridge.onclose = (_, c) => {
      code = c
    }
    bridge.send(new Uint8Array(MAX_FRAME + 1))
    await sleep(20)
    expect(code).toBe(1009)
    expect(written.map((f) => f.kind)).toEqual([OPEN, CLOSE])
  })
})

describe('FrameParser', () => {
  it('splits frames however the bytes arrive', () => {
    const bytes = Buffer.concat([
      encodeFrame(EVENT, 0, Buffer.from('{}')),
      encodeFrame(DATA, 3, Buffer.from([7, 8])),
    ])
    const parser = new FrameParser()
    const got = []
    for (const b of bytes) got.push(...parser.push(Buffer.from([b])))
    expect(got.map((f) => [f.kind, f.stream, f.payload.length])).toEqual([
      [EVENT, 0, 2],
      [DATA, 3, 2],
    ])
  })

  it('refuses an unknown kind and a length over 64 MiB', () => {
    const big = Buffer.alloc(9)
    big[0] = DATA
    big.writeUInt32BE(64 * 1024 * 1024 + 1, 5)
    for (const bad of [encodeFrame(9, 0), encodeFrame(0, 0), big]) {
      const parser = new FrameParser()
      expect(parser.push(bad)).toEqual([])
      expect(parser.error).toBeInstanceOf(FrameError)
    }
  })

  it('keeps the frames before a bad one, and parses nothing after it', () => {
    const parser = new FrameParser()
    const bytes = Buffer.concat([
      encodeFrame(EVENT, 0, Buffer.from('{}')),
      encodeFrame(9, 0),
      encodeFrame(DATA, 1, Buffer.from([1])),
    ])
    expect(parser.push(bytes).map((f) => f.kind)).toEqual([EVENT])
    expect(parser.error).toBeInstanceOf(FrameError)
    expect(parser.push(encodeFrame(DATA, 1, Buffer.from([1])))).toEqual([])
  })

  it('takes a 64 MiB frame in 64 KiB chunks without copying it over and over', () => {
    const size = 64 * 1024 * 1024
    const bytes = encodeFrame(DATA, 1, Buffer.alloc(size))
    const parser = new FrameParser()
    const start = Date.now()
    const got = []
    for (let at = 0; at < bytes.length; at += 65536)
      got.push(...parser.push(bytes.subarray(at, at + 65536)))
    expect(got).toHaveLength(1)
    expect(got[0]?.payload.length).toBe(size)
    expect(Date.now() - start).toBeLessThan(5000)
  })
})

describe('back-pressure', () => {
  it('closes the stream that is behind, not the one that sends next', async () => {
    // A child that takes nothing: no write ever completes.
    const stdin = new Writable({ highWaterMark: 1, write() {} })
    const streams = new Streams(stdin)
    const slow = streams.open('edit', () => {})
    const quick = streams.open('edit', () => {})
    const codes: Record<string, number | undefined> = {}
    slow.onclose = (_, c) => {
      codes.slow = c
    }
    quick.onclose = (_, c) => {
      codes.quick = c
    }
    const chunk = new Uint8Array(MAX_FRAME / 2 + 1)
    slow.send(chunk)
    slow.send(chunk)
    quick.send(new Uint8Array([1]))
    await sleep(10)
    expect(codes).toEqual({ slow: 1013 })
  })
})
