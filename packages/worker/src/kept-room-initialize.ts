import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { effectiveKeepSeconds } from './kept-lifetime.ts'
import { KeptTransport } from './kept-transport.ts'

async function body(request: Request): Promise<ArrayBuffer> {
  if (!request.body) throw new Error('checkpoint missing')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_FRAME_BYTES) {
        await reader.cancel()
        throw new Error('checkpoint too large')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (!size) throw new Error('checkpoint missing')
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result.buffer
}

export async function initializeKeptRoom(
  request: Request,
  state: DurableObjectState,
  env: Env & { KEEP_MAX_SECONDS?: string },
  roomId: string,
  roomMaxSeconds: number | null,
  maintenanceClosed: () => boolean,
): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const host = /^Host ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '')?.[1]
  const editor = request.headers.get('X-Pedit-Editor')
  const commenter = request.headers.get('X-Pedit-Commenter')
  const reader = request.headers.get('X-Pedit-Reader')
  const epoch = request.headers.get('X-Pedit-Epoch')
  const requestedHeader = request.headers.get('X-Pedit-Keep-Seconds')
  const configured = env.KEEP_MAX_SECONDS
  if (
    configured !== undefined &&
    (!/^[1-9][0-9]{0,15}$/.test(configured) || !Number.isSafeInteger(Number(configured)))
  )
    return new Response(null, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  const maxKeepSeconds = configured === undefined ? null : Number(configured)
  if (!requestedHeader || !/^[1-9][0-9]{0,31}$/.test(requestedHeader))
    return new Response(null, { status: 400 })
  const requestedBig = BigInt(requestedHeader)
  const effectiveBig =
    maxKeepSeconds === null
      ? requestedBig
      : requestedBig < BigInt(maxKeepSeconds)
        ? requestedBig
        : BigInt(maxKeepSeconds)
  if (effectiveBig > BigInt(Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 1000)))
    return new Response(null, { status: 400 })
  const requested = Number(effectiveBig)
  if (
    !host ||
    !editor ||
    !commenter ||
    !reader ||
    !epoch ||
    !Number.isSafeInteger(requested) ||
    requested < 1
  )
    return new Response(null, { status: 400 })
  try {
    const checkpoint = await body(request)
    const transport = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 50 * 1024 * 1024, frames: 10000 },
      {
        requestedSeconds: requested,
        roomMaxSeconds,
        maxKeepSeconds,
        alarmSeconds: 3600,
      },
      Date.now,
      maintenanceClosed,
    )
    await transport.initializeAway(roomId, host, { editor, commenter, reader }, epoch, checkpoint)
    return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
        'X-Pedit-Keep-Seconds': String(effectiveKeepSeconds(requested, maxKeepSeconds)),
      },
    })
  } catch {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
}
