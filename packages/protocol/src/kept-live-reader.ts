import { isKeptRoomKeys } from './kept-access.ts'
import {
  type KeptReadInspection,
  KeptRoomClient,
  type KeptRoomClientOptions,
  keptReadAdmission,
} from './kept-room-client.ts'

// Notifications are hints. A fixed read is the source of each candidate; the
// timer covers a durable commit whose notification was lost.
export class KeptLiveReader {
  private socket: WebSocket | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly controller = new AbortController()
  private readonly reader: KeptRoomClient
  private readonly opts: KeptRoomClientOptions
  private dirty = 0
  private running = false
  private stopped = false
  constructor(
    input: KeptRoomClientOptions,
    private readonly onCandidate: (result: KeptReadInspection) => void,
    private readonly onError: (error: Error) => void,
    private readonly connect: (url: string, protocols: string[]) => WebSocket = (url, protocols) =>
      new WebSocket(url, protocols),
    private readonly pollMs = 5000,
  ) {
    const opts = { ...input, anchor: input.anchor ? { ...input.anchor } : undefined }
    this.opts = opts
    if (!isKeptRoomKeys(opts.keys) || !Number.isSafeInteger(pollMs) || pollMs < 1000)
      throw new Error('invalid live reader')
    this.reader = new KeptRoomClient(opts)
  }
  start(): void {
    if (this.socket || this.stopped) throw new Error('live reader already started')
    const url = new URL(this.opts.url)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `${url.pathname.replace(/\/$/, '')}/internal/kept/${this.opts.keys.roomId}/guest`
    const socket = this.connect(url.toString(), [
      'pedit-v6',
      `pedit-admission.${keptReadAdmission(this.opts.keys)}`,
    ])
    this.socket = socket
    socket.addEventListener('open', () => {
      if (this.stopped) return
      this.timer = setInterval(() => {
        if (!this.running) this.refresh()
      }, this.pollMs)
      this.refresh()
    })
    socket.addEventListener('message', (event) => {
      if (event.data !== 'changed') {
        this.fail()
        return
      }
      this.refresh()
    })
    socket.addEventListener('error', () => this.fail())
    socket.addEventListener('close', () => this.fail())
  }
  private refresh(): void {
    if (this.stopped) return
    this.dirty++
    if (!this.running) void this.read()
  }
  private async read(): Promise<void> {
    this.running = true
    try {
      while (!this.stopped) {
        const observed = this.dirty
        const candidate = await this.reader.inspect(this.controller.signal)
        if (this.stopped) return
        if (observed !== this.dirty) continue
        this.onCandidate(candidate)
        if (observed === this.dirty) break
      }
    } catch {
      if (!this.stopped) this.fail()
    } finally {
      this.running = false
    }
  }
  private fail(): void {
    if (this.stopped) return
    this.stop()
    this.onError(new Error('kept live connection lost'))
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.controller.abort()
    clearInterval(this.timer)
    this.socket?.close()
  }
}
