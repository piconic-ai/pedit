import { defineProvider, onHost } from './define.ts'

const PLAYER = 'https://w.soundcloud.com/player/'
const PATH = /^\/player\/?$/
// Share > Embed names a track or playlist of the API, by its number or its URN.
const TARGET =
  /^\/(tracks|playlists)\/(?:soundcloud(?::|%3[Aa])(tracks|playlists)(?::|%3[Aa]))?(\d{1,20})$/

function apiUrl(href: string | null): URL | null {
  try {
    return href ? new URL(href) : null
  } catch {
    return null
  }
}

export default defineProvider({
  name: 'SoundCloud',
  frames: [PLAYER],
  // The classic player.
  size: { height: 166 },
  /**
   * SoundCloud's player names what it plays in its url= parameter, which no
   * frame-src can check: only a track or playlist of SoundCloud's API passes,
   * rebuilt along with the rest of the query.
   */
  embed(url) {
    if (!onHost(url, 'w.soundcloud.com') || !PATH.test(url.pathname)) return null
    const target = apiUrl(url.searchParams.get('url'))
    if (!target || target.protocol !== 'https:' || !onHost(target, 'api.soundcloud.com'))
      return null
    if (target.search || target.hash) return null
    const m = TARGET.exec(target.pathname)
    if (!m || (m[2] !== undefined && m[2] !== m[1])) return null
    const what = encodeURIComponent(`https://api.soundcloud.com/${m[1]}/${m[3]}`)
    return `${PLAYER}?url=${what}&auto_play=false`
  },
  allow: ['autoplay'],
})
