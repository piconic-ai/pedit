import { connect } from 'node:net'
import { WebSocket } from 'ws'
import type { Role } from './types.ts'

export const MAX_FRAME = 16 * 1024 * 1024

export interface Bridge {
  /** page -> pedit. A frame over 16 MiB closes the bridge. */
  send(frame: Uint8Array): void
  /** pedit -> page (single handler). Frames that arrive before it is set are held. */
  onframe: ((frame: Uint8Array) => void) | null
  /** `code` is pedit's close code, passed through (1005/1006 when it gave none). */
  onclose: ((reason: string, code?: number) => void) | null
  close(): void
}

/** Dial the child's socket. `ws+unix://` URLs break on paths with spaces, so hand ws the connection. */
export async function dialSocket(
  socketPath: string,
  role: Role,
  onGone: () => void,
): Promise<Bridge> {
  const ws = new WebSocket('ws://pedit/', {
    createConnection: () => connect(socketPath),
    headers: role === 'read' ? { 'X-Pedit-Role': 'read' } : {},
    perMessageDeflate: false,
    maxPayload: 4 * MAX_FRAME,
    handshakeTimeout: 5000,
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    ws.once('unexpected-response', () => reject(new Error('pedit refused the connection')))
  })
  ws.removeAllListeners('error')
  ws.on('error', () => ws.terminate())

  let handler: Bridge['onframe'] = null
  const held: Uint8Array[] = []
  let heldBytes = 0
  let gone = false
  let closing = false
  const bridge: Bridge = {
    send(frame) {
      if (ws.readyState !== WebSocket.OPEN) return
      if (frame.byteLength > MAX_FRAME) return ws.close(1009, 'frame too large')
      ws.send(frame, { binary: true })
      if (ws.bufferedAmount > MAX_FRAME) ws.close(1013, 'too slow')
    },
    get onframe() {
      return handler
    },
    set onframe(fn) {
      handler = fn
      heldBytes = 0
      if (fn) for (const f of held.splice(0)) fn(f)
    },
    onclose: null,
    close() {
      if (closing) return
      closing = true
      ws.close(1000)
      // Do not wait for a stuck peer to answer: the slot must come back.
      setTimeout(() => ws.terminate(), 2000).unref()
    },
  }
  ws.on('message', (data) => {
    const frame = Array.isArray(data) ? Buffer.concat(data) : new Uint8Array(data as Buffer)
    if (handler) return handler(frame)
    held.push(frame)
    heldBytes += frame.byteLength
    if (heldBytes > MAX_FRAME) ws.close(1013, 'no reader')
  })
  ws.on('close', (code, reason) => {
    if (gone) return
    gone = true
    onGone()
    bridge.onclose?.(reason.toString(), code)
  })
  return bridge
}
