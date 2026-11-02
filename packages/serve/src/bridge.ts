import type { Writable } from 'node:stream'
import type { Role } from './types.ts'

export const MAX_FRAME = 16 * 1024 * 1024
/** The most pedit's framing allows in one frame (docs/design/serve.md). */
const MAX_PAYLOAD = 64 * 1024 * 1024
const HEADER = 9

export const OPEN = 1
export const DATA = 2
export const CLOSE = 3
export const EVENT = 4

export interface Bridge {
  /** page -> pedit. A frame over 16 MiB closes the bridge. */
  send(frame: Uint8Array): void
  /** pedit -> page (single handler). Frames that arrive before it is set are held. */
  onframe: ((frame: Uint8Array) => void) | null
  /** `code` is pedit's close code, passed through (1005/1006 when it gave none). */
  onclose: ((reason: string, code?: number) => void) | null
  close(): void
}

export interface Frame {
  kind: number
  stream: number
  payload: Buffer
}

/** pedit sent something that is not a frame: the child cannot be trusted any more. */
export class FrameError extends Error {}

/** kind (1 byte) | stream (uint32 BE) | length (uint32 BE) | payload */
export function encodeFrame(kind: number, stream: number, payload?: Uint8Array): Buffer {
  const body = payload ?? new Uint8Array(0)
  const head = Buffer.alloc(HEADER)
  head[0] = kind
  head.writeUInt32BE(stream, 1)
  head.writeUInt32BE(body.byteLength, 5)
  return Buffer.concat([head, body])
}

/** Splits the child's stdout into frames; throws FrameError on anything that is not one. */
export class FrameParser {
  #buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): Frame[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk
    const frames: Frame[] = []
    for (;;) {
      if (this.#buf.length < HEADER) break
      const kind = this.#buf[0] as number
      const length = this.#buf.readUInt32BE(5)
      if (kind < DATA || kind > EVENT) throw new FrameError(`unknown frame kind ${kind}`)
      if (length > MAX_PAYLOAD) throw new FrameError('frame too large')
      if (this.#buf.length < HEADER + length) break
      frames.push({
        kind,
        stream: this.#buf.readUInt32BE(1),
        payload: this.#buf.subarray(HEADER, HEADER + length),
      })
      this.#buf = this.#buf.subarray(HEADER + length)
    }
    return frames
  }
}

interface Stream {
  frame(payload: Buffer): void
  end(reason: string, code: number): void
}

/** The streams of one child: ids start at 1 and are never reused. */
export class Streams {
  #stdin: Writable
  #next = 1
  #streams = new Map<number, Stream>()

  constructor(stdin: Writable) {
    this.#stdin = stdin
  }

  /** A data or close frame from pedit. One for a stream already closed here is dropped. */
  deliver(frame: Frame) {
    const stream = this.#streams.get(frame.stream)
    if (!stream) return
    if (frame.kind === DATA) return stream.frame(frame.payload)
    const p = frame.payload
    if (p.length >= 2) stream.end(p.subarray(2).toString(), p.readUInt16BE(0))
    else stream.end('', 1005)
  }

  /** The child is gone: end every stream. */
  abort() {
    for (const s of [...this.#streams.values()]) s.end('', 1006)
  }

  #write(frame: Buffer) {
    if (this.#stdin.writable && !this.#stdin.destroyed) this.#stdin.write(frame)
  }

  /** Open a stream. `onGone` is called once, when it ends. */
  open(role: Role, onGone: () => void): Bridge {
    const id = this.#next++
    this.#write(encodeFrame(OPEN, id, Uint8Array.of(role === 'read' ? 1 : 0)))
    let handler: Bridge['onframe'] = null
    const held: Uint8Array[] = []
    let heldBytes = 0
    let closeHandler: Bridge['onclose'] = null
    let ended: { reason: string; code: number } | undefined
    const end = (reason: string, code: number) => {
      if (ended) return
      ended = { reason, code }
      this.#streams.delete(id)
      onGone()
      closeHandler?.(reason, code)
    }
    const close = (code: number, reason: string) => {
      if (ended) return
      this.#write(encodeFrame(CLOSE, id))
      end(reason, code)
    }
    this.#streams.set(id, {
      frame(payload) {
        const frame = new Uint8Array(payload)
        if (handler) return handler(frame)
        held.push(frame)
        heldBytes += frame.byteLength
        if (heldBytes > MAX_FRAME) close(1013, 'no reader')
      },
      end,
    })
    return {
      send: (frame) => {
        if (ended) return
        if (frame.byteLength > MAX_FRAME) return close(1009, 'frame too large')
        this.#write(encodeFrame(DATA, id, frame))
        if (this.#stdin.writableLength > MAX_FRAME) close(1013, 'too slow')
      },
      get onframe() {
        return handler
      },
      set onframe(fn) {
        handler = fn
        heldBytes = 0
        if (fn) for (const f of held.splice(0)) fn(f)
      },
      get onclose() {
        return closeHandler
      },
      set onclose(fn) {
        closeHandler = fn
        if (fn && ended) fn(ended.reason, ended.code)
      },
      close: () => close(1000, ''),
    }
  }
}
