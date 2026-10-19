import { defineProvider, onHost } from './define.ts'

const PLAYER = 'https://www.loom.com/embed/'
const PATH = /^\/(?:share|embed)\/([\da-f]{32})\/?$/

export default defineProvider({
  name: 'Loom',
  frames: [PLAYER],
  size: { ratio: '16/9' },
  embed(url) {
    const m = onHost(url, 'loom.com', 'www.loom.com') ? PATH.exec(url.pathname) : null
    if (!m) return null
    // Where to start, in seconds; Loom's other parameters are left behind.
    const t = url.searchParams.get('t')
    return `${PLAYER}${m[1]}${t && /^\d{1,6}$/.test(t) ? `?t=${t}` : ''}`
  },
  sandbox: ['allow-presentation'],
  allow: ['fullscreen', 'autoplay'],
})
