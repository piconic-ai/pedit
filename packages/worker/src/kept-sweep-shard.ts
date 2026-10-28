import { DurableObject } from 'cloudflare:workers'
import { KeptSweepRegistry } from './kept-sweep-registry.ts'

// Not bound in deployment config. Callers must preserve the shard mapping.
export class KeptSweepShard extends DurableObject<Env> {
  private registry = new KeptSweepRegistry(this.ctx.storage, 100_000)
  register(id: string): Promise<void> {
    return this.registry.register(id)
  }
  next(): Promise<{ id: string; generation: number } | null> {
    return this.registry.next()
  }
  retire(id: string, generation: number): Promise<void> {
    return this.registry.retire(id, generation)
  }
}

export function keptShardName(roomId: string): string {
  if (!/^[0-9a-f]{64}$/.test(roomId)) throw new Error('invalid room id')
  return roomId[0]!
}
