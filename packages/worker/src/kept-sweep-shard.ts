import { DurableObject } from 'cloudflare:workers'
import { KeptSweepRegistry } from './kept-sweep-registry.ts'

// Not bound in deployment config. Callers must preserve the shard mapping.
export class KeptSweepShard extends DurableObject<Env> {
  private registry = new KeptSweepRegistry(this.ctx.storage, 100_000)
  private pending: Promise<unknown> | undefined
  private timedOut = false

  private async run<T>(start: () => Promise<T>): Promise<T> {
    if (this.pending) throw new Error(this.timedOut ? 'registry unavailable' : 'registry busy')
    const operation = start()
    this.pending = operation
    const clear = () => {
      if (this.pending === operation) {
        this.pending = undefined
        this.timedOut = false
      }
    }
    void operation.then(clear, clear)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.timedOut = true
            reject(new Error('registry timed out'))
          }, 1000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  register(id: string): Promise<void> {
    return this.run(() => this.registry.register(id))
  }
  next(): Promise<{ id: string; generation: number } | null> {
    return this.run(() => this.registry.next())
  }
  retire(id: string, generation: number): Promise<void> {
    return this.run(() => this.registry.retire(id, generation))
  }
}

export function keptShardName(roomId: string): string {
  if (!/^[0-9a-f]{64}$/.test(roomId)) throw new Error('invalid room id')
  return roomId[0]!
}
