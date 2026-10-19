import { defineProvider } from './define.ts'

const PLAYER = 'https://player.vimeo.com/video/'

export default defineProvider({
  name: 'Vimeo',
  frames: [PLAYER],
  size: { ratio: '16/9' },
  embed(url) {
    const host = url.hostname.replace(/^www\./, '')
    const m =
      host === 'vimeo.com'
        ? /^\/(\d+)(?:\/([\da-f]+))?\/?$/.exec(url.pathname)
        : host === 'player.vimeo.com'
          ? /^\/video\/(\d+)\/?$/.exec(url.pathname)
          : null
    if (!m) return null
    // Unlisted videos need their hash, either in the path or as ?h=.
    const hash = m[2] ?? url.searchParams.get('h')
    const query = hash && /^[\da-f]+$/.test(hash) ? `?h=${hash}` : ''
    return `${PLAYER}${m[1]}${query}`
  },
  sandbox: ['allow-presentation'],
  allow: ['fullscreen', 'picture-in-picture', 'encrypted-media'],
})
