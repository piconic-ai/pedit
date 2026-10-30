import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'

type KeptText = {
  snapshot: string
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

export async function expireKeptText(storage: DurableObjectStorage): Promise<boolean> {
  const state = storage.kv.get<KeptText>('keptText')
  if (!state) return storage.kv.get<boolean>('keptTextClosed') === true
  if (Date.now() < Math.min(state.until, state.total ?? Infinity)) return false
  storage.transactionSync(() => {
    storage.kv.delete('keptText')
    storage.kv.put('keptTextClosed', true)
    storage.sql.exec('DELETE FROM kept_text_log')
  })
  await storage.deleteAlarm()
  await storage.sync()
  return true
}
export async function keptText(
  request: Request,
  storage: DurableObjectStorage,
  host: boolean,
  maxKeep: string | undefined,
  maxRoom: string | undefined,
): Promise<Response> {
  const action = new URL(request.url).pathname.split('/').at(-1)
  if (await expireKeptText(storage)) return new Response(null, { status: 410 })
  let stored = false
  let state = storage.kv.get<KeptText>('keptText')
  const token = request.headers.get('X-Pedit-Admission')
  const reply = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
  try {
    if (action === 'init' && host && request.method === 'POST') {
      if (state || storage.kv.get('openedAt') !== undefined)
        return new Response(null, { status: 409 })
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
      state = {
        snapshot,
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
      storage.transactionSync(() => {
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
      })
      stored = true
    } else {
      if (!state) return new Response(null, { status: 404 })
      if (!host && token !== state.editor && token !== state.reader)
        return new Response(null, { status: 403 })
      if (action === 'append' && request.method === 'POST' && token === state.editor) {
        const sender = request.headers.get('X-Pedit-Sender') ?? ''
        if (!/^[A-Za-z0-9_-]{1,36}$/.test(sender)) throw new Error('invalid sender')
        const data = await body(request)
        storage.transactionSync(() => {
          const current = storage.kv.get<KeptText>('keptText')
          if (!current || Date.now() >= Math.min(current.until, current.total ?? Infinity))
            throw new Error('room closed')
          const usage = storage.sql
            .exec<{ bytes: number; count: number }>(
              'SELECT coalesce(sum(length(body)), 0) AS bytes, count(*) AS count FROM kept_text_log',
            )
            .one()
          if (usage.bytes + data.length > 4 * MAX_FRAME_BYTES || usage.count >= 1000)
            throw new Error('room log full')
          state = { ...current, tail: current.tail + 1 }
          storage.sql.exec(
            'INSERT INTO kept_text_log (id, body, sender) VALUES (?, ?, ?)',
            state.tail,
            data,
            sender,
          )
          storage.kv.put('keptText', state)
        })
        stored = true
      } else if (host && action === 'checkpoint' && request.method === 'POST') {
        const snapshot = encode(await body(request)),
          cutoff = Number(request.headers.get('X-Pedit-Cutoff'))
        storage.transactionSync(() => {
          const current = storage.kv.get<KeptText>('keptText')
          if (
            !current ||
            Date.now() >= Math.min(current.until, current.total ?? Infinity) ||
            !Number.isSafeInteger(cutoff) ||
            cutoff < current.cutoff ||
            cutoff > current.tail
          )
            throw new Error('invalid cutoff')
          state = { ...current, snapshot, cutoff }
          storage.sql.exec('DELETE FROM kept_text_log WHERE id <= ?', cutoff)
          storage.kv.put('keptText', state)
        })
        stored = true
      } else if (host && action === 'away' && request.method === 'POST')
        state = { ...state, away: true, until: Date.now() + state.seconds * 1000 }
      else if (host && action === 'connect' && request.method === 'POST')
        state = {
          ...state,
          away: false,
          hostSeen: Date.now(),
          until: Date.now() + state.seconds * 1000,
        }
      else if (action === 'keep' && request.method === 'GET') {
        if (host && !state.away)
          state = { ...state, hostSeen: Date.now(), until: Date.now() + state.seconds * 1000 }
      } else return new Response(null, { status: 403 })
    }
    if (!state) throw new Error('room unavailable')
    if (!stored) storage.kv.put('keptText', state)
    const response =
      request.method !== 'GET'
        ? reply({
            keepSeconds: state.seconds,
            keepUntil: Math.min(state.until, state.total ?? Infinity),
          })
        : reply({
            snapshot: state.snapshot,
            entries: storage.sql
              .exec<{ id: number; body: ArrayBuffer }>(
                'SELECT id, body FROM kept_text_log ORDER BY id',
              )
              .toArray()
              .map((row) => ({ id: row.id, body: encode(new Uint8Array(row.body)) })),
            tail: state.tail,
            hostAway: state.away || Date.now() - state.hostSeen > 15000,
            keepUntil: Math.min(state.until, state.total ?? Infinity),
          })
    await armKeptText(storage)
    await storage.sync()
    return response
  } catch {
    return new Response(null, { status: 400 })
  }
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
export async function keptTextAlarm(storage: DurableObjectStorage): Promise<boolean> {
  if (!storage.kv.get('keptText') && !storage.kv.get('keptTextClosed')) return false
  try {
    if (!(await expireKeptText(storage))) await armKeptText(storage)
  } catch (error) {
    await storage.setAlarm(Date.now() + 60000)
    throw error
  }
  return true
}
