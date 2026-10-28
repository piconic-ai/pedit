import { MAX_FRAME_BYTES } from './frame.ts'

export type KeptReadSnapshot = {
  epoch: string
  generation: number
  cutoff: number
  ciphertext: string
  session: string
  cursor: string
  tail: number
}
export type KeptReadPage = {
  entries: { sequence: number; ciphertext: string }[]
  next: string | null
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const epoch = /^(?!0{64}$)[0-9a-f]{64}$/
function parse(raw: string, keys: string[]): Record<string, unknown> {
  if (raw.length > 2 * MAX_FRAME_BYTES) throw new Error('read response too large')
  const value: unknown = JSON.parse(raw)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(value) !== raw ||
    Object.keys(value).join() !== keys.join()
  )
    throw new Error('invalid read response')
  return value as Record<string, unknown>
}
function integer(v: unknown, min: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min
}
function identifier(v: unknown): v is string {
  return typeof v === 'string' && uuid.test(v)
}
function cipher(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4) return false
  try {
    const decoded = atob(v)
    return decoded.length > 0 && decoded.length <= MAX_FRAME_BYTES && btoa(decoded) === v
  } catch {
    return false
  }
}
export function parseKeptReadSnapshot(raw: string): KeptReadSnapshot {
  const v = parse(raw, ['epoch', 'generation', 'cutoff', 'ciphertext', 'tail', 'session', 'cursor'])
  if (
    typeof v.epoch !== 'string' ||
    !epoch.test(v.epoch) ||
    !integer(v.generation, 1) ||
    !integer(v.cutoff, 0) ||
    !integer(v.tail, 0) ||
    v.tail < v.cutoff ||
    !cipher(v.ciphertext) ||
    !identifier(v.session) ||
    !identifier(v.cursor)
  )
    throw new Error('invalid read snapshot')
  return {
    epoch: v.epoch,
    generation: v.generation,
    cutoff: v.cutoff,
    ciphertext: v.ciphertext,
    session: v.session,
    cursor: v.cursor,
    tail: v.tail,
  }
}
export function parseKeptReadPage(raw: string, after: number, tail: number): KeptReadPage {
  if (!integer(after, 0) || !integer(tail, 0) || tail < after)
    throw new Error('invalid read bounds')
  const v = parse(raw, ['entries', 'next'])
  if (
    !Array.isArray(v.entries) ||
    v.entries.length > 16 ||
    !(v.next === null || identifier(v.next))
  )
    throw new Error('invalid read page')
  let seq = after,
    total = 0
  const entries = v.entries.map((item: unknown) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).join() !== 'sequence,ciphertext'
    )
      throw new Error('invalid read entry')
    const entry = item as Record<string, unknown>
    if (
      !integer(entry.sequence, 1) ||
      entry.sequence <= seq ||
      entry.sequence > tail ||
      !cipher(entry.ciphertext)
    )
      throw new Error('invalid read entry')
    seq = entry.sequence
    total += atob(entry.ciphertext).length
    if (total > MAX_FRAME_BYTES) throw new Error('read page too large')
    return { sequence: entry.sequence, ciphertext: entry.ciphertext }
  })
  if ((v.next === null && seq < tail) || (v.next !== null && (entries.length === 0 || seq >= tail)))
    throw new Error('incomplete read page')
  return { entries, next: v.next }
}

// This anchor is saved by the host from an earlier accepted read. It cannot
// testify to operations that arrived while the host was offline.
export type KeptReadAnchor = Pick<
  KeptReadSnapshot,
  'epoch' | 'generation' | 'cutoff' | 'ciphertext' | 'tail'
>
export function checkKeptReadAnchor(
  snapshot: KeptReadSnapshot,
  anchor: KeptReadAnchor,
): 'tail-unverified' {
  if (
    snapshot.epoch !== anchor.epoch ||
    snapshot.generation !== anchor.generation ||
    snapshot.cutoff !== anchor.cutoff ||
    snapshot.ciphertext !== anchor.ciphertext ||
    snapshot.tail < anchor.tail
  )
    throw new Error('read anchor mismatch')
  return 'tail-unverified'
}
