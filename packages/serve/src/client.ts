import * as decoding from 'lib0/decoding'
import { Awareness } from 'y-protocols/awareness'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

export type Role = 'edit' | 'read'
export type Status = 'connecting' | 'connected' | 'reconnecting' | 'closed'
export type PeditErrorCode = 'not-found' | 'held' | 'busy' | 'forbidden' | 'gone' | 'unavailable'

export class PeditError extends Error {
  code: PeditErrorCode
  constructor(code: PeditErrorCode, message: string = code) {
    super(message)
    this.name = 'PeditError'
    this.code = code
  }
}

export interface Connection {
  doc: Y.Doc
  /** `doc.getText('content')`: the file's text. */
  text: Y.Text
  /** Unauthenticated: anyone who can connect can claim any name. */
  awareness: Awareness
  /** For `read`, no update is ever sent; also make the editor read-only (`EditorState.readOnly.of(true)`). */
  role: Role
  status: { get(): Status; subscribe(cb: (s: Status, error?: PeditError) => void): () => void }
  /** Resolves after the first sync. */
  synced: Promise<void>
  destroy(): void
}

const REASONS: Record<number, PeditErrorCode> = {
  403: 'forbidden',
  404: 'not-found',
  409: 'held',
  503: 'busy',
}
const MAX_DELAY_MS = 30_000

async function session(url: string): Promise<{ token: string; role: Role }> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', credentials: 'same-origin' })
  } catch (e) {
    throw new PeditError('unavailable', String((e as Error)?.message))
  }
  if (!res.ok) throw new PeditError(REASONS[res.status] ?? 'unavailable', `session: ${res.status}`)
  const body = (await res.json()) as { token?: string; role?: Role }
  if (typeof body.token !== 'string' || (body.role !== 'edit' && body.role !== 'read')) {
    throw new PeditError('unavailable', 'bad session response')
  }
  return { token: body.token, role: body.role }
}

/**
 * Open `${base}/${id}` (where `peditRoutes` is mounted): issue a session, connect, and resolve
 * after the first sync. Reconnects with a fresh token until the server says it is gone.
 */
export async function connect(
  base: string,
  id: string,
  options: { name?: string; color?: string } = {},
): Promise<Connection> {
  const root = `${base.replace(/\/$/, '')}/${encodeURIComponent(id)}`
  const sessionUrl = `${location.origin}${root}/session`
  const first = await session(sessionUrl)
  const role = first.role

  const doc = new Y.Doc()
  const text = doc.getText('content')
  const awareness = new Awareness(doc)
  const provider = new WebsocketProvider(
    `${location.origin.replace(/^http/, 'ws')}${root}`,
    'doc',
    doc,
    { connect: false, disableBc: true, params: { token: first.token }, awareness },
  )
  // A reader never sends an update; pedit also refuses one, with close code 4003.
  if (role === 'read') {
    doc.off('update', (provider as unknown as { _updateHandler: never })._updateHandler)
  }
  if (options.name || options.color) {
    const color = options.color ?? '#3b82f6'
    awareness.setLocalStateField('user', {
      name: options.name ?? 'guest',
      color,
      colorLight: `${color}33`,
    })
  }

  let status: Status = 'connecting'
  const subs = new Set<(s: Status, error?: PeditError) => void>()
  const setStatus = (s: Status, error?: PeditError) => {
    if (status === 'closed') return
    status = s
    for (const cb of [...subs]) cb(s, error)
  }
  const isClosed = () => status === 'closed'
  let halting = false
  // disconnect() emits connection-close itself; do not handle that one.
  const halt = () => {
    halting = true
    try {
      provider.disconnect()
    } finally {
      halting = false
    }
  }
  let destroyed = false
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const stop = (error: PeditError) => {
    clearTimeout(timer)
    halt()
    settle?.reject(error)
    setStatus('closed', error)
  }
  async function retry() {
    if (destroyed || isClosed()) return
    try {
      const next = await session(sessionUrl)
      if (destroyed || isClosed()) return
      // Live role changes are not supported: the update handler and the editor were set up for one role.
      if (next.role !== role)
        return stop(new PeditError('forbidden', 'role changed; connect again'))
      provider.params = { token: next.token }
      provider.connect()
    } catch (e) {
      const err = e instanceof PeditError ? e : new PeditError('unavailable')
      if (err.code === 'forbidden' || err.code === 'not-found') return stop(err)
      schedule()
    }
  }
  function schedule() {
    clearTimeout(timer)
    const delay = Math.min(MAX_DELAY_MS, 1000 * 2 ** attempts++)
    timer = setTimeout(retry, delay)
  }

  let settle: { resolve(): void; reject(e: PeditError): void } | undefined
  const synced = new Promise<void>((resolve, reject) => {
    settle = { resolve, reject }
  })
  synced.catch(() => {})

  // A restarted pedit seeds a new document from the file. Merging this tab's old copy into it
  // would duplicate the text, so if the server's state vector lacks something it gave us, stop.
  const syncHandler = provider.messageHandlers[0] as NonNullable<
    (typeof provider.messageHandlers)[0]
  >
  provider.messageHandlers[0] = (...args: Parameters<typeof syncHandler>) => {
    const dec = args[1]
    const peek = decoding.createDecoder(dec.arr)
    peek.pos = dec.pos
    if (hasSynced && decoding.readVarUint(peek) === 0) {
      const server = Y.decodeStateVector(decoding.readVarUint8Array(peek))
      const local = Y.decodeStateVector(Y.encodeStateVector(doc))
      for (const [client, clock] of local) {
        if (client !== doc.clientID && (server.get(client) ?? 0) < clock) {
          return stop(new PeditError('gone', 'the document was restarted; reload'))
        }
      }
    }
    syncHandler(...args)
  }
  let hasSynced = false

  provider.on('sync', (isSynced: boolean) => {
    if (!isSynced) return
    hasSynced = true
    attempts = 0
    setStatus('connected')
    settle?.resolve()
  })
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (destroyed || isClosed() || halting) return
    halt()
    if (event?.code === 4001 || event?.code === 4003) {
      const err = new PeditError(event.code === 4001 ? 'gone' : 'forbidden')
      return stop(err)
    }
    setStatus(status === 'connecting' ? 'connecting' : 'reconnecting')
    schedule()
  })

  const connection: Connection = {
    doc,
    text,
    awareness,
    role,
    status: {
      get: () => status,
      subscribe(cb) {
        subs.add(cb)
        return () => subs.delete(cb)
      },
    },
    synced,
    destroy() {
      destroyed = true
      clearTimeout(timer)
      halt()
      provider.destroy()
      awareness.destroy()
      subs.clear()
    },
  }
  provider.connect()
  try {
    await synced
  } catch (e) {
    connection.destroy()
    throw e
  }
  return connection
}
