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
export const COMMAND = 5
/** The most pedit takes in one command frame (docs/design/embedding.md "Commands"). */
export const MAX_COMMAND = 64 * 1024

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

interface Head {
  kind: number
  stream: number
  length: number
}

/**
 * Splits the child's stdout into frames. On anything that is not a frame it keeps what it parsed
 * before, sets `error`, and parses nothing more.
 */
export class FrameParser {
  /** Set once the stream broke the format; nothing is parsed after it. */
  error: FrameError | undefined
  #chunks: Buffer[] = []
  #size = 0
  #head: Head | undefined

  /** Take `n` bytes off the front. A frame within one chunk is not copied. */
  #take(n: number): Buffer {
    this.#size -= n
    const first = this.#chunks[0]
    if (first && first.length >= n) {
      if (first.length === n) this.#chunks.shift()
      else this.#chunks[0] = first.subarray(n)
      return first.subarray(0, n)
    }
    const parts: Buffer[] = []
    for (let left = n; left > 0; ) {
      const chunk = this.#chunks[0] as Buffer
      if (chunk.length <= left) {
        parts.push(chunk)
        this.#chunks.shift()
        left -= chunk.length
      } else {
        parts.push(chunk.subarray(0, left))
        this.#chunks[0] = chunk.subarray(left)
        left = 0
      }
    }
    return Buffer.concat(parts, n)
  }

  #readHead(): Head | undefined {
    if (this.#size < HEADER) return undefined
    const b = this.#take(HEADER)
    const head = { kind: b[0] as number, stream: b.readUInt32BE(1), length: b.readUInt32BE(5) }
    if (head.kind < DATA || head.kind > EVENT)
      throw new FrameError(`unknown frame kind ${head.kind}`)
    if (head.length > MAX_PAYLOAD) throw new FrameError('frame too large')
    return head
  }

  push(chunk: Buffer): Frame[] {
    const frames: Frame[] = []
    if (this.error) return frames
    this.#chunks.push(chunk)
    this.#size += chunk.length
    try {
      for (;;) {
        this.#head ??= this.#readHead()
        const head = this.#head
        if (!head || this.#size < head.length) break
        frames.push({ kind: head.kind, stream: head.stream, payload: this.#take(head.length) })
        this.#head = undefined
      }
    } catch (e) {
      if (!(e instanceof FrameError)) throw e
      this.error = e
      this.#chunks = []
      this.#size = 0
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

  #write(frame: Buffer, flushed?: () => void) {
    if (this.#stdin.writable && !this.#stdin.destroyed) this.#stdin.write(frame, flushed)
  }

  /** A command to pedit: one JSON object on stream 0. */
  command(json: string) {
    this.#write(encodeFrame(COMMAND, 0, Buffer.from(json)))
  }

  /** Open a stream. `onGone` is called once, when it ends. */
  open(role: Role, onGone: () => void): Bridge {
    const id = this.#next++
    this.#write(encodeFrame(OPEN, id, Uint8Array.of(role === 'read' ? 1 : 0)))
    let handler: Bridge['onframe'] = null
    const held: Uint8Array[] = []
    let heldBytes = 0
    let queued = 0 // bytes of this stream's data written to stdin and not yet taken by the child
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
        const out = encodeFrame(DATA, id, frame)
        queued += out.length
        this.#write(out, () => {
          queued -= out.length
        })
        if (queued > MAX_FRAME) close(1013, 'too slow')
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
