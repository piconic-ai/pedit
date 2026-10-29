import { readBoundedBody } from './bounded-body.ts'
import { KeptAdmission } from './kept-admission.ts'
import { KeptBlobCleanup, KeptBlobConflictError, type KeptBlobLimits } from './kept-blob-cleanup.ts'
import { KeptLifecycle } from './kept-lifecycle.ts'

const MAX_UPLOADS = 4
const MAX_GUEST_UPLOADS = MAX_UPLOADS - 1

async function getBlob(
  bucket: R2Bucket,
  key: string,
  active: () => Promise<void>,
): Promise<Response> {
  const object = await bucket.get(key)
  await active()
  if (!object) return new Response(null, { status: 404 })
  return new Response(object.body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  })
}

async function authorizeBlob(
  admission: KeptAdmission,
  room: string,
  token: string,
  host: boolean,
  method: string,
): Promise<void> {
  if (host) return admission.authorizeHost(room, token)
  const role = await admission.role(token)
  if (!role || (method === 'PUT' && role !== 'editor')) throw new Error('blob admission denied')
}

export async function keptRoomBlob(
  request: Request,
  state: DurableObjectState,
  env: Env,
  room: string,
  id: string,
  limits: KeptBlobLimits,
  uploading: Map<string, 'host' | 'editor'>,
  maintenanceClosed: () => boolean,
): Promise<Response> {
  if (env.ROOM.idFromName(room).toString() !== state.id.toString())
    return new Response(null, { status: 404 })
  const auth = /^(Host|Bearer) ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get('Authorization') ?? '',
  )
  if (!auth?.[2]) return new Response(null, { status: 403 })
  if (request.method !== 'GET' && request.method !== 'PUT')
    return new Response(null, { status: 405 })
  const admission = new KeptAdmission(state, env.ROOM)
  const life = new KeptLifecycle(
    state,
    env.ROOM,
    { requestedSeconds: 1, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 3600 },
    Date.now,
    maintenanceClosed,
  )
  const active = async () => {
    await life.observe()
    life.assertOpen()
  }
  let authorized = false
  try {
    await authorizeBlob(admission, room, auth[2], auth[1] === 'Host', request.method)
    authorized = true
    await active()
    if (request.method === 'GET')
      return await getBlob(env.BLOBS, `kept/${state.id.toString()}/${id}`, active)
    const role = auth[1] === 'Host' ? 'host' : 'editor'
    const guestCount = [...uploading.values()].filter((owner) => owner === 'editor').length
    if (
      uploading.has(id) ||
      uploading.size >= MAX_UPLOADS ||
      (role === 'editor' && guestCount >= MAX_GUEST_UPLOADS)
    )
      return new Response(null, { status: 409 })
    uploading.set(id, role)
    try {
      const data = new Uint8Array(await readBoundedBody(request, limits.blobBytes))
      if (!data.length) throw new Error('missing blob')
      await active()
      const cleanup = new KeptBlobCleanup(state, env.BLOBS, limits, () => life.assertOpen())
      await cleanup.put(id, data)
      await active()
      return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
    } finally {
      uploading.delete(id)
    }
  } catch (error) {
    if (authorized) await life.observe().catch(() => {})
    return new Response(null, {
      status: error instanceof KeptBlobConflictError ? 409 : 403,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
