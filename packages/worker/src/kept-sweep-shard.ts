import { DurableObject } from 'cloudflare:workers'
import { KeptSweepRegistry } from './kept-sweep-registry.ts'

// Not bound in deployment config. Callers must preserve the shard mapping.
export class KeptSweepShard extends DurableObject<Env> {
  private registry = new KeptSweepRegistry(this.ctx.storage, 100_000)
  private pendingNext: ReturnType<KeptSweepRegistry['next']> | undefined
  private nextTimedOut = false
  private nextWaiting = false
  register(id: string): Promise<void> {
    return this.registry.register(id)
  }
  async next(): Promise<{ id: string; generation: number } | null> {
    if (this.nextTimedOut) throw new Error('registry unavailable')
    if (this.nextWaiting) throw new Error('registry busy')
    if (!this.pendingNext) {
      const pending = this.registry.next()
      this.pendingNext = pending
      const clear = () => {
        if (this.pendingNext === pending) {
          this.pendingNext = undefined
          this.nextTimedOut = false
        }
      }
      void pending.then(clear, clear)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    this.nextWaiting = true
    try {
      return await Promise.race([
        this.pendingNext,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.nextTimedOut = true
            reject(new Error('registry timed out'))
          }, 1000)
        }),
      ])
    } finally {
      clearTimeout(timer)
      this.nextWaiting = false
    }
  }
  retire(id: string, generation: number): Promise<void> {
    return this.registry.retire(id, generation)
  }
}

export function keptShardName(roomId: string): string {
  if (!/^[0-9a-f]{64}$/.test(roomId)) throw new Error('invalid room id')
  return roomId[0]!
}
