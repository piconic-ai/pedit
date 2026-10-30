import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'

type KeptText = {
  snapshot: string
  snapshotTag: string
  editor: string
  reader: string
  seconds: number
  until: number
  total: number | null
  hostSeen: number
  away: boolean
  tail: number
  cutoff: number
}
const encode = (data: Uint8Array) => {
  let text = ''
  for (let i = 0; i < data.length; i += 8192)
    text += String.fromCharCode(...data.subarray(i, i + 8192))
  return btoa(text)
}
async function body(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = []
  let size = 0,
    count = 0,
    expired = false
  if (!reader) throw new Error('missing body')
  const timer = setTimeout(() => {
    expired = true
    void reader.cancel().catch(() => {})
  }, 30000)
  try {
    for (;;) {
      const part = await reader.read()
      if (expired) throw new Error('body timed out')
      if (part.done) break
      size += part.value.length
      if (size > MAX_FRAME_BYTES || ++count > 8192) {
        void reader.cancel().catch(() => {})
        throw new Error('body too large')
      }
      chunks.push(part.value)
    }
    if (!size) throw new Error('missing body')
    const data = new Uint8Array(size)
    let at = 0
    for (const chunk of chunks) {
      data.set(chunk, at)
      at += chunk.length
    }
    return data
  } finally {
    clearTimeout(timer)
    reader.releaseLock()
  }
}

export async function expireKeptText(
  storage: DurableObjectStorage,
  removeBlobs: () => Promise<void>,
): Promise<boolean> {
  const state = storage.kv.get<KeptText>('keptText')
  if (!state) return storage.kv.get<boolean>('keptTextClosed') === true
  if (Date.now() < Math.min(state.until, state.total ?? Infinity)) return false
  await endKeptText(storage, removeBlobs, false)
  return true
}
// Ends the room for good: the ID cannot be used again. byHost tells a guest
// whose next request is refused that the host closed it, not that it expired.
async function endKeptText(
  storage: DurableObjectStorage,
  removeBlobs: () => Promise<void>,
  byHost: boolean,
): Promise<void> {
  storage.transactionSync(() => {
    storage.kv.delete('keptText')
    storage.kv.put('keptTextClosed', true)
    if (byHost) storage.kv.put('keptTextClosedByHost', true)
    storage.sql.exec('DELETE FROM kept_text_log')
  })
  await storage.deleteAlarm()
  await storage.sync()
  // The room's images go with its text; a failure is left to the bucket's
  // lifecycle rule for `kept/`.
  await removeBlobs()
}
// Answers a request for a room that is gone, or one that the host closes now.
async function closedOrClosing(
  request: Request,
  action: string | undefined,
  storage: DurableObjectStorage,
  host: boolean,
  removeBlobs: () => Promise<void>,
): Promise<Response | undefined> {
  const closing = action === 'close' && request.method === 'POST'
  if (closing && !host) return new Response(null, { status: 403 })
  if (await expireKeptText(storage, removeBlobs)) {
    if (closing) return Response.json({})
    const byHost = storage.kv.get('keptTextClosedByHost')
    return new Response(null, { status: 410, headers: byHost ? { 'X-Pedit-Closed': 'host' } : {} })
  }
  if (!closing) return undefined
  if (!storage.kv.get('keptText')) return new Response(null, { status: 404 })
  await endKeptText(storage, removeBlobs, true)
  return Response.json({})
}
export async function keptText(
  request: Request,
  storage: DurableObjectStorage,
  host: boolean,
  maxKeep: string | undefined,
  maxRoom: string | undefined,
  removeBlobs: () => Promise<void>,
): Promise<Response> {
  const action = new URL(request.url).pathname.split('/').at(-1)
  const early = await closedOrClosing(request, action, storage, host, removeBlobs)
  if (early) return early
  let state = storage.kv.get<KeptText>('keptText')
  const token = request.headers.get('X-Pedit-Admission')
  try {
    if (action === 'init' && host && request.method === 'POST') {
      if (state || storage.kv.get('openedAt') !== undefined)
        return new Response(null, { status: 409 })
      state = await initialize(request, storage, maxKeep, maxRoom)
    } else {
      if (!state) return new Response(null, { status: 404 })
      if (!host && token !== state.editor && token !== state.reader)
        return new Response(null, { status: 403 })
      const result = await changeState(
        request,
        storage,
        action,
        host,
        token === state.editor,
        state,
      )
      if (result instanceof Response) return result
      state = result
    }
    state = storage.kv.get<KeptText>('keptText')
    if (!state) throw new Error('room unavailable')
    const response = stateResponse(request, storage, state)
    await armKeptText(storage)
    await storage.sync()
    return response
  } catch {
    return new Response(null, { status: 400 })
  }
}

async function changeState(
  request: Request,
  storage: DurableObjectStorage,
  action: string | undefined,
  host: boolean,
  editor: boolean,
  state: KeptText,
): Promise<KeptText | Response> {
  switch (action) {
    case 'append':
      if (request.method !== 'POST' || !editor) return new Response(null, { status: 403 })
      return appendUpdate(request, storage)
    case 'checkpoint':
      if (!host || request.method !== 'POST') return new Response(null, { status: 403 })
      return checkpointUpdate(request, storage)
    default: {
      const changed = lifecycle(request, action, host, state)
      if (!changed) return new Response(null, { status: 403 })
      storage.kv.put('keptText', changed)
      return changed
    }
  }
}

function lifecycle(
  request: Request,
  action: string | undefined,
  host: boolean,
  state: KeptText,
): KeptText | undefined {
  const now = Date.now()
  if (host && request.method === 'POST') {
    if (action === 'away') return { ...state, away: true, until: now + state.seconds * 1000 }
    if (action === 'connect')
      return { ...state, away: false, hostSeen: now, until: now + state.seconds * 1000 }
  }
  if (action !== 'keep' || request.method !== 'GET') return undefined
  return host && !state.away
    ? { ...state, hostSeen: now, until: now + state.seconds * 1000 }
    : state
}
function stateResponse(request: Request, storage: DurableObjectStorage, state: KeptText): Response {
  const keepUntil = Math.min(state.until, state.total ?? Infinity)
  const headers = new Headers({ 'Cache-Control': 'no-store' })
  if (request.method !== 'GET')
    return Response.json({ keepSeconds: state.seconds, keepUntil }, { headers })
  const after = Number(new URL(request.url).searchParams.get('after') ?? '0')
  if (!Number.isSafeInteger(after) || after < 0 || after > state.tail)
    throw new Error('invalid kept cursor')
  const full = after === 0 || after < state.cutoff
  const hostAway = state.away || Date.now() - state.hostSeen > 15000
  const etag = `"${state.snapshotTag}-${state.tail}"`
  headers.set('ETag', etag)
  if (full && request.headers.get('If-None-Match') === etag) {
    headers.set('X-Pedit-Cutoff', String(state.cutoff))
    headers.set('X-Pedit-Tail', String(state.tail))
    headers.set('X-Pedit-Host-Away', String(hostAway))
    headers.set('X-Pedit-Keep-Until', String(keepUntil))
    return new Response(null, { status: 304, headers })
  }
  return Response.json(
    {
      ...(full ? { snapshot: state.snapshot } : {}),
      entries: storage.sql
        .exec<{ id: number; body: ArrayBuffer }>(
          'SELECT id, body FROM kept_text_log WHERE id > ? ORDER BY id',
          after,
        )
        .toArray()
        .map((row) => ({ id: row.id, body: encode(new Uint8Array(row.body)) })),
      cutoff: state.cutoff,
      tail: state.tail,
      hostAway,
      keepUntil,
    },
    { headers },
  )
}

async function initialize(
  request: Request,
  storage: DurableObjectStorage,
  maxKeep: string | undefined,
  maxRoom: string | undefined,
): Promise<KeptText> {
  const requested = Number(request.headers.get('X-Pedit-Keep-Seconds'))
  const cap = maxKeep === undefined ? requested : Number(maxKeep)
  const seconds = Math.min(requested, cap)
  const editor = request.headers.get('X-Pedit-Editor') ?? '',
    reader = request.headers.get('X-Pedit-Reader') ?? ''
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    !Number.isSafeInteger(Date.now() + seconds * 1000) ||
    !/^[A-Za-z0-9_-]{43}$/.test(editor) ||
    !/^[A-Za-z0-9_-]{43}$/.test(reader)
  )
    throw new Error('invalid keep initialization')
  const snapshot = encode(await body(request)),
    now = Date.now()
  const limit = Number(maxRoom) || 0
  const state: KeptText = {
    snapshot,
    snapshotTag: crypto.randomUUID(),
    editor,
    reader,
    seconds,
    until: now + seconds * 1000,
    total: limit > 0 ? now + Math.max(limit, seconds) * 1000 : null,
    hostSeen: now,
    away: false,
    tail: 0,
    cutoff: 0,
  }
  await storage.transaction(async () => {
    if (
      storage.kv.get('keptText') ||
      storage.kv.get('keptTextClosed') ||
      storage.kv.get('openedAt') !== undefined
    )
      throw new Error('room already initialized')
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS kept_text_log (id INTEGER PRIMARY KEY, body BLOB NOT NULL, sender TEXT NOT NULL)',
    )
    storage.kv.put('keptText', state)
    const deadline = Math.min(state.until, state.total ?? Infinity),
      old = await storage.getAlarm()
    if (old === null || deadline < old) await storage.setAlarm(deadline)
  })
  return state
}

async function appendUpdate(request: Request, storage: DurableObjectStorage): Promise<KeptText> {
  const sender = request.headers.get('X-Pedit-Sender') ?? ''
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(sender)) throw new Error('invalid sender')
  const data = await body(request)
  return storage.transactionSync(() => {
    const current = storage.kv.get<KeptText>('keptText')
    if (!current || Date.now() >= Math.min(current.until, current.total ?? Infinity))
      throw new Error('room closed')
    const usage = storage.sql
      .exec<{ bytes: number; count: number }>(
        'SELECT coalesce(sum(length(body)), 0) AS bytes, count(*) AS count FROM kept_text_log',
      )
      .one()
    if (usage.bytes + data.length > 4 * MAX_FRAME_BYTES || usage.count >= 10000)
      throw new Error('room log full')
    const state = { ...current, tail: current.tail + 1 }
    storage.sql.exec(
      'INSERT INTO kept_text_log (id, body, sender) VALUES (?, ?, ?)',
      state.tail,
      data,
      sender,
    )
    storage.kv.put('keptText', state)
    return state
  })
}

async function checkpointUpdate(
  request: Request,
  storage: DurableObjectStorage,
): Promise<KeptText> {
  const snapshot = encode(await body(request)),
    cutoff = Number(request.headers.get('X-Pedit-Cutoff'))
  return storage.transactionSync(() => {
    const current = storage.kv.get<KeptText>('keptText')
    if (
      !current ||
      Date.now() >= Math.min(current.until, current.total ?? Infinity) ||
      !Number.isSafeInteger(cutoff) ||
      cutoff < current.cutoff ||
      cutoff > current.tail
    )
      throw new Error('invalid cutoff')
    const state = { ...current, snapshot, snapshotTag: crypto.randomUUID(), cutoff }
    storage.sql.exec('DELETE FROM kept_text_log WHERE id <= ?', cutoff)
    storage.kv.put('keptText', state)
    return state
  })
}

async function armKeptText(storage: DurableObjectStorage): Promise<void> {
  await storage.transaction(async () => {
    const state = storage.kv.get<KeptText>('keptText')
    if (!state) return
    const deadline = Math.min(state.until, state.total ?? Infinity),
      old = await storage.getAlarm()
    if (old === null || deadline < old) await storage.setAlarm(deadline)
  })
}
export async function keptTextAlarm(
  storage: DurableObjectStorage,
  removeBlobs: () => Promise<void>,
): Promise<boolean> {
  if (!storage.kv.get('keptText') && !storage.kv.get('keptTextClosed')) return false
  try {
    if (!(await expireKeptText(storage, removeBlobs))) await armKeptText(storage)
  } catch (error) {
    await storage.setAlarm(Date.now() + 60000)
    throw error
  }
  return true
}
