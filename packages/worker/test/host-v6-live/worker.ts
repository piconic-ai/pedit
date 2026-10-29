import app from '../../src/index.ts'
import { KeptTransport } from '../../src/kept-transport.ts'
import { Room as ProductionRoom } from '../../src/room.ts'

export class Room extends ProductionRoom {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__test/state') {
      return Response.json(this.ctx.storage.kv.get('keptLifetime') ?? null)
    }
    if (new URL(request.url).pathname === '/__test/populate') {
      const { token, epoch, records } = await request.json<{
        token: string
        epoch: string
        records: string[]
      }>()
      const transport = new KeptTransport(
        this.ctx,
        this.env.ROOM,
        { bytes: 50 * 1024 * 1024, frames: 10000 },
        { requestedSeconds: 1, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 3600 },
      )
      for (const record of records) {
        const bytes = Uint8Array.from(atob(record), (c) => c.charCodeAt(0))
        await transport.append(token, epoch, bytes.buffer)
      }
      return new Response(null, { status: 204 })
    }
    if (new URL(request.url).pathname === '/__test/advance') {
      const room = request.headers.get('X-Test-Room')!
      const host = request.headers.get('X-Test-Host')!
      const epoch = request.headers.get('X-Test-Epoch')!
      const nextEpoch = request.headers.get('X-Test-Next-Epoch')!
      const transport = new KeptTransport(
        this.ctx,
        this.env.ROOM,
        { bytes: 50 * 1024 * 1024, frames: 10000 },
        { requestedSeconds: 1, roomMaxSeconds: null, maxKeepSeconds: null, alarmSeconds: 3600 },
      )
      const cut = await transport.freeze(room, host, epoch, 1)
      await transport.commit(room, host, cut, nextEpoch, await request.arrayBuffer())
      return new Response(null, { status: 204 })
    }
    return super.fetch(request)
  }
}
const pageAttempts = new Map<string, number>()

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/__test/')) {
      const room = request.headers.get('X-Test-Room')
      if (!room || !/^[A-Za-z0-9_-]{22}$/.test(room)) return new Response(null, { status: 400 })
      return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request)
    }
    const limited = request.headers.get('X-Test-Page-Limit')
    if (!limited) return app.fetch(request, env, ctx)
    const configured = {
      ...env,
      KEEP_PUBLIC_V6: '1',
      KEPT_PAGE_LIMIT: {
        limit: async () => {
          const count = pageAttempts.get(limited) ?? 0
          pageAttempts.set(limited, count + 1)
          return { success: count > 0 }
        },
      } as RateLimit,
    }
    const response = await app.fetch(request, configured, ctx)
    if (response.status !== 429) return response
    return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
  },
}
