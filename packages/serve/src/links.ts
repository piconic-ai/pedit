const SECOND = 1_000_000_000n
const MAX_DURATION = (1n << 63n) - 1n
const units: Record<string, bigint> = {
  h: 3600n * SECOND,
  m: 60n * SECOND,
  s: SECOND,
  ms: 1_000_000n,
  us: 1000n,
  µs: 1000n,
  μs: 1000n,
  ns: 1n,
}

/** Parse a CLI keep duration into whole seconds. `0` means a live room. */
export function parseKeep(value: string): number {
  if (value === '0') return 0
  let nanos = 0n
  if (/^\d+d$/.test(value)) nanos = BigInt(value.slice(0, -1)) * 86400n * SECOND
  else {
    const duration = value.replace(/^\+/, '')
    const part = /(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g
    let end = 0
    for (const match of duration.matchAll(part)) {
      if (match.index !== end) throw new TypeError('invalid keep duration')
      const [whole = '', fraction = ''] = (match[1] ?? '').split('.')
      const unit = units[match[2] ?? ''] ?? 0n
      nanos += BigInt(whole || '0') * unit
      if (fraction) nanos += (BigInt(fraction) * unit) / 10n ** BigInt(fraction.length)
      end += match[0].length
    }
    if (end !== duration.length) throw new TypeError('invalid keep duration')
  }
  if (nanos <= 0n || nanos > MAX_DURATION || nanos % SECOND !== 0n)
    throw new TypeError('keep must be whole seconds within the CLI duration range')
  return Number(nanos / SECOND)
}

/** Format whole seconds as a canonical CLI keep duration. */
export function formatKeep(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || BigInt(seconds) * SECOND > MAX_DURATION)
    throw new TypeError('keep must be whole seconds within the CLI duration range')
  if (seconds === 0) return '0'
  for (const [unit, size] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ] as const) {
    if (seconds % size === 0) return `${seconds / size}${unit}`
  }
  return `${seconds}s`
}

/** Construct a relay editor or app page URL. Secrets appear only in the fragment. */
export function linkUrl(link: string, target: { relay: string } | { page: string }): string {
  const dot = link.indexOf('.')
  const room = link.slice(0, dot)
  const fragment = link.slice(dot + 1)
  if (
    !/^[A-Za-z0-9_-]{22}$/.test(room) ||
    !/^(?:[A-Za-z0-9_-]{43}|c\.[A-Za-z0-9_-]{86}|r\.[A-Za-z0-9_-]{128})$/.test(fragment)
  )
    throw new TypeError('invalid room link')
  let url: URL
  try {
    url = new URL('relay' in target ? target.relay : target.page)
  } catch {
    throw new TypeError('invalid link destination')
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new TypeError('invalid link destination')
  if ('relay' in target) {
    if (url.search || url.hash) throw new TypeError('invalid relay destination')
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/r/${room}`
    url.hash = fragment
  } else url.hash = link
  return url.href
}
