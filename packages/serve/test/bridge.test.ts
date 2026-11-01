import { mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { dialSocket } from '../src/bridge.ts'
import { sleep, tmpRoot } from './helpers.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** A Unix WebSocket server that talks the moment a client connects, as pedit does. */
async function peer(onConnect: (ws: import('ws').WebSocket) => void): Promise<string> {
  const { dir, cleanup } = tmpRoot()
  mkdirSync(dir, { recursive: true })
  const socket = join(dir, 's.sock')
  const wss = new WebSocketServer({ noServer: true })
  const http: Server = createServer()
  http.on('upgrade', (req, sock, head) => wss.handleUpgrade(req, sock, head, onConnect))
  await new Promise<void>((r) => http.listen(socket, r))
  cleanups.push(
    cleanup,
    () => {
      for (const c of wss.clients) c.terminate()
      http.close()
    },
    () => rmSync(socket, { force: true }),
  )
  return socket
}

describe('dialSocket', () => {
  it('keeps frames that arrive before onframe is set', async () => {
    const socket = await peer((ws) => {
      ws.send(new Uint8Array([1, 2, 3]))
      ws.send(new Uint8Array([4]))
    })
    for (let i = 0; i < 5; i++) {
      const bridge = await dialSocket(socket, 'edit', () => {})
      await sleep(50)
      const got: number[][] = []
      bridge.onframe = (f) => got.push([...f])
      expect(got).toEqual([[1, 2, 3], [4]])
      bridge.close()
    }
  })

  it('keeps the close that arrives before onclose is set, and frees the slot once', async () => {
    let gone = 0
    const socket = await peer((ws) => ws.close(4003, 'read-only connection'))
    const bridge = await dialSocket(socket, 'read', () => gone++)
    await sleep(100)
    const seen: [string, number | undefined][] = []
    bridge.onclose = (reason, code) => seen.push([reason, code])
    expect(seen).toEqual([['read-only connection', 4003]])
    expect(gone).toBe(1)
  })
})
