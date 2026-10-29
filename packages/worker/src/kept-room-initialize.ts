import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import {
  BodyChunkLimitError,
  BodyReadTimeoutError,
  BodyTooLargeError,
  InvalidBodyLengthError,
  readBoundedBody,
} from './bounded-body.ts'
import { KeptAdmission } from './kept-admission.ts'
import { type KeepPolicy } from './kept-lifecycle.ts'
import { effectiveKeepSeconds } from './kept-lifetime.ts'
import { KEPT_POLICY_KEY, KeptTransport } from './kept-transport.ts'

export type InitializeSlots = { active: number }
const MAX_INITIALIZATIONS = 4

function initializationPolicy(
  saved: KeepPolicy | undefined,
  requestedBig: bigint,
  roomMaxSeconds: number | null,
  maxKeepSeconds: number | null,
): KeepPolicy | Response {
  const cap = saved ? saved.maxKeepSeconds : maxKeepSeconds
  const effective =
    cap === null ? requestedBig : requestedBig < BigInt(cap) ? requestedBig : BigInt(cap)
  if (effective > BigInt(Number.MAX_SAFE_INTEGER)) return new Response(null, { status: 400 })
  const requested = Number(effective)
  if (!saved && effective > BigInt(Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 1000)))
    return new Response(null, { status: 400 })
  if (saved && requested !== saved.requestedSeconds) throw new Error('kept duration changed')
  return (
    saved ?? { requestedSeconds: requested, roomMaxSeconds, maxKeepSeconds, alarmSeconds: 3600 }
  )
}

function initializationFailure(error: unknown): Response {
  if (error instanceof BodyReadTimeoutError) return new Response(null, { status: 408 })
  if (error instanceof BodyTooLargeError) return new Response(null, { status: 413 })
  if (error instanceof InvalidBodyLengthError || error instanceof BodyChunkLimitError)
    return new Response(null, { status: 400 })
  return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } })
}

export async function initializeKeptRoom(
  request: Request,
  state: DurableObjectState,
  env: Env & { KEEP_MAX_SECONDS?: string },
  roomId: string,
  roomMaxSeconds: number | null,
  maintenanceClosed: () => boolean,
  slots: InitializeSlots = { active: 0 },
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
  if (!host || !editor || !commenter || !reader || !epoch)
    return new Response(null, { status: 400 })
  const requestedBig = BigInt(requestedHeader)
  try {
    await new KeptAdmission(state, env.ROOM).authenticateHost(roomId, host)
  } catch {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  if (slots.active >= MAX_INITIALIZATIONS) return new Response(null, { status: 429 })
  slots.active++
  try {
    const checkpoint = await readBoundedBody(request, MAX_FRAME_BYTES)
    if (!checkpoint.byteLength) return new Response(null, { status: 400 })
    const saved = state.storage.kv.get<KeepPolicy>(KEPT_POLICY_KEY)
    const policy = initializationPolicy(saved, requestedBig, roomMaxSeconds, maxKeepSeconds)
    if (policy instanceof Response) return policy
    const transport = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 50 * 1024 * 1024, frames: 10000 },
      policy,
      Date.now,
      maintenanceClosed,
    )
    await transport.initializeAway(roomId, host, { editor, commenter, reader }, epoch, checkpoint)
    return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
        'X-Pedit-Keep-Seconds': String(
          effectiveKeepSeconds(policy.requestedSeconds, policy.maxKeepSeconds),
        ),
      },
    })
  } catch (error) {
    return initializationFailure(error)
  } finally {
    slots.active--
  }
}
