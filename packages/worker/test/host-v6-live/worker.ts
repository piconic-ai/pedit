import { Room as ProductionRoom } from '../../src/room.ts'

export class Room extends ProductionRoom {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__test/state') {
      return Response.json(this.ctx.storage.kv.get('keptLifetime') ?? null)
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
