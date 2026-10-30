import app from '../../../../packages/worker/src/index.ts'
import { Room as ProductionRoom } from '../../../../packages/worker/src/room.ts'
export class Room extends ProductionRoom {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/__test/kept/')) {
      const snapshot = this.ctx.storage.kv.get<{ snapshot: string }>('keptText')
      const exists = this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE name = 'kept_text_log'")
        .toArray().length
      const bytes = exists
        ? this.ctx.storage.sql
            .exec<{ bytes: number }>(
              'SELECT coalesce(sum(length(body)), 0) AS bytes FROM kept_text_log',
            )
            .one().bytes
        : 0
      const entries = exists
        ? this.ctx.storage.sql
            .exec<{ count: number }>('SELECT count(*) AS count FROM kept_text_log')
            .one().count
        : 0
      return Response.json({ bytes: bytes + (snapshot?.snapshot.length ?? 0), entries })
    }
    return super.fetch(request)
  }
}
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const id = /^\/__test\/kept\/([A-Za-z0-9_-]{22})$/.exec(new URL(request.url).pathname)?.[1]
    return id ? env.ROOM.get(env.ROOM.idFromName(id)).fetch(request) : app.fetch(request, env, ctx)
  },
}
