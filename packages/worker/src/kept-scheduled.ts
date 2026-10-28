import type { KeptSweepShard } from './kept-sweep-shard.ts'

type SweepEnv = Env & { KEPT_SWEEP?: DurableObjectNamespace<KeptSweepShard> }
const SHARDS = '0123456789abcdef'
const TIMEOUT_MS = 1000
const BUDGET_PER_SHARD = 16

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('kept sweep timed out')), TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function scheduledKeptSweep(env: SweepEnv): Promise<void> {
  if (!env.KEPT_SWEEP) return
  const namespace = env.KEPT_SWEEP
  await Promise.all(
    SHARDS.split('').map(async (name) => {
      const shard = namespace.getByName(name)
      const seen = new Set<string>()
      for (let i = 0; i < BUDGET_PER_SHARD; i++) {
        try {
          const entry = await bounded(shard.next())
          if (entry === null || seen.has(entry.id)) return
          seen.add(entry.id)
          const room = env.ROOM.get(env.ROOM.idFromString(entry.id))
          if (await bounded(room.sweepKeptAttachments()))
            await bounded(shard.retire(entry.id, entry.generation))
        } catch {
          console.error('kept sweep failed', name)
        }
      }
    }),
  )
}
