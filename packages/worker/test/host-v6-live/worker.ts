import { KeptTransport } from '../../src/kept-transport.ts'
import { Room as ProductionRoom } from '../../src/room.ts'

export class Room extends ProductionRoom {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__test/state') {
      return Response.json(this.ctx.storage.kv.get('keptLifetime') ?? null)
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
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const room = request.headers.get('X-Test-Room')
    if (!room || !/^[A-Za-z0-9_-]{22}$/.test(room)) return new Response(null, { status: 400 })
    return env.ROOM.get(env.ROOM.idFromName(room)).fetch(request)
  },
}
