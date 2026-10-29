import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { RELAY_BYTE_RATE, RELAY_MESSAGE_RATE } from '@pedit/protocol/pace'
import {
  BodyChunkLimitError,
  BodyReadTimeoutError,
  BodyTooLargeError,
  InvalidBodyLengthError,
  readBoundedBody,
} from './bounded-body.ts'
import { KeptAdmission, type KeptRole } from './kept-admission.ts'
import { KeptTransport } from './kept-transport.ts'

type Allowance = { at: number; messages: number; bytes: number }

// Two authenticated writing tiers share one allowance each. Neither the token
// nor an unbounded number of client identities is retained by the relay.
export class KeptAppendRate {
  private readonly roles = new Map<KeptRole, Allowance>()
  private readonly active = new Map<KeptRole, number>()
  constructor(private readonly now: () => number = Date.now) {}
  reserve(role: KeptRole): boolean {
    const count = this.active.get(role) ?? 0
    if (count >= 8 || !this.take(role, 1, 0)) return false
    this.active.set(role, count + 1)
    return true
  }
  charge(role: KeptRole, bytes: number): boolean {
    return this.take(role, 0, bytes)
  }
  release(role: KeptRole): void {
    const count = this.active.get(role) ?? 0
    if (count <= 1) this.active.delete(role)
    else this.active.set(role, count - 1)
  }
  private take(role: KeptRole, messages: number, bytes: number): boolean {
    const now = this.now()
    const state = this.roles.get(role) ?? {
      at: now,
      messages: RELAY_MESSAGE_RATE.burst,
      bytes: RELAY_BYTE_RATE.burst,
    }
    const seconds = Math.max(0, now - state.at) / 1000
    state.at = Math.max(now, state.at)
    state.messages = Math.min(
      RELAY_MESSAGE_RATE.burst,
      state.messages + seconds * RELAY_MESSAGE_RATE.perSecond,
    )
    state.bytes = Math.min(RELAY_BYTE_RATE.burst, state.bytes + seconds * RELAY_BYTE_RATE.perSecond)
    this.roles.set(role, state)
    if (state.messages < messages || state.bytes < bytes) return false
    state.messages -= messages
    state.bytes -= bytes
    return true
  }
}

export async function keptAppend(
  request: Request,
  state: DurableObjectState,
  env: Env,
  roomId: string,
  rate: KeptAppendRate,
  maintenanceClosed: () => boolean,
): Promise<Response> {
  const response = (status: number) =>
    new Response(null, { status, headers: { 'Cache-Control': 'no-store' } })
  if (request.method !== 'POST') return response(405)
  if (env.ROOM.idFromName(roomId).toString() !== state.id.toString()) return response(404)
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '')?.[1]
  const epoch = request.headers.get('X-Pedit-Epoch')
  if (!token || !epoch || epoch.length > 128) return response(400)
  const role = await new KeptAdmission(state, env.ROOM).role(token)
  if (role !== 'editor' && role !== 'commenter') return response(403)
  if (!rate.reserve(role)) return response(429)
  try {
    const body = await readBoundedBody(request, MAX_FRAME_BYTES)
    if (!body.byteLength) return response(400)
    if (!rate.charge(role, body.byteLength)) return response(429)
    const transport = new KeptTransport(
      state,
      env.ROOM,
      { bytes: 50 * 1024 * 1024, frames: 10000 },
      { requestedSeconds: 1, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 3600 },
      Date.now,
      maintenanceClosed,
    )
    const sequence = await transport.append(token, epoch, body)
    return Response.json({ sequence }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof BodyReadTimeoutError) return response(408)
    if (error instanceof BodyChunkLimitError) return response(400)
    if (error instanceof BodyTooLargeError) return response(413)
    if (error instanceof InvalidBodyLengthError) return response(400)
    return response(403)
  } finally {
    rate.release(role)
  }
}
