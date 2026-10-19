import { defineProvider } from './define.ts'

// The no-cookie player does not set tracking cookies until playback starts.
const PLAYER = 'https://www.youtube-nocookie.com/embed/'
const ID = /^[\w-]{11}$/

/** Reads YouTube's `t=90` or `t=1m30s`. */
function seconds(t: string | null): number {
  if (!t) return 0
  if (/^\d+$/.test(t)) return Number(t)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t)
  if (!m) return 0
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

export default defineProvider({
  name: 'YouTube',
  frames: [PLAYER],
  // Shorts are filmed upright.
  size: (url) => (url.pathname.startsWith('/shorts/') ? { ratio: '9/16' } : { ratio: '16/9' }),
  embed(url) {
    const host = url.hostname.replace(/^(www|m)\./, '')
    const [, first, second] = url.pathname.split('/')
    let id: string | null | undefined
    if (host === 'youtu.be') {
      id = first
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (first === 'watch') id = url.searchParams.get('v')
      else if (first === 'shorts' || first === 'embed' || first === 'live') id = second
    }
    if (!id || !ID.test(id)) return null
    const start = seconds(url.searchParams.get('t') ?? url.searchParams.get('start'))
    return `${PLAYER}${id}${start ? `?start=${start}` : ''}`
  },
  sandbox: ['allow-presentation'],
  allow: ['fullscreen', 'picture-in-picture', 'encrypted-media'],
})
