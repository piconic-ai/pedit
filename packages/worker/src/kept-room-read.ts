import { MAX_FRAME_BYTES } from '@pedit/protocol/frame'
import { KeptTransport } from './kept-transport.ts'

function base64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return btoa(binary)
}

async function cancelRead(
  transport: KeptTransport,
  kind: string,
  token: string,
  roomId: string,
  session: string,
): Promise<Response> {
  if (kind === 'Host') await transport.cancelHostRead(roomId, token, session)
  else await transport.cancelRead(token, session)
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
}

export async function keptRoomRead(
  request: Request,
  state: DurableObjectState,
  env: Env,
  roomId: string,
  maintenanceClosed: () => boolean,
): Promise<Response> {
  if (
    !/^[A-Za-z0-9_-]{22}$/.test(roomId) ||
    env.ROOM.idFromName(roomId).toString() !== state.id.toString()
  )
    return new Response(null, { status: 404 })
  const auth = /^(Host|Bearer) ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get('Authorization') ?? '',
  )
  if (!auth) return new Response(null, { status: 403 })
  const [, kind, token] = auth
  if (!token || !kind) return new Response(null, { status: 403 })
  const session = request.headers.get('X-Pedit-Read-Session')
  const cursor = request.headers.get('X-Pedit-Read-Cursor')
  const transport = new KeptTransport(
    state,
    env.ROOM,
    { bytes: MAX_FRAME_BYTES, frames: 1 },
    { requestedSeconds: 1, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 3600 },
    Date.now,
    maintenanceClosed,
  )
  try {
    if (request.method === 'POST' && session === null && cursor === null) {
      const checkpoint =
        kind === 'Host'
          ? await transport.beginHostRead(roomId, token)
          : await transport.beginRead(token)
      return Response.json(
        { ...checkpoint, ciphertext: base64(checkpoint.ciphertext) },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }
    if (request.method === 'DELETE' && session && cursor === null)
      return await cancelRead(transport, kind, token, roomId, session)
    if (!session || !cursor) return new Response(null, { status: 400 })
    if (request.method === 'GET') {
      const page =
        kind === 'Host'
          ? await transport.readHostPage(roomId, token, session, cursor)
          : await transport.readPage(token, session, cursor)
      return Response.json(
        {
          ...page,
          entries: page.entries.map((entry) => ({
            ...entry,
            ciphertext: base64(entry.ciphertext),
          })),
        },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }
    if (request.method === 'DELETE') {
      if (kind === 'Host') await transport.finishHostRead(roomId, token, session, cursor)
      else await transport.finishRead(token, session, cursor)
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    }
    return new Response(null, { status: 405 })
  } catch {
    return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
}
