import { defineProvider, onHost } from './define.ts'

const PLAYER = 'https://open.spotify.com/embed/'
// A share link may name the listener's locale (/intl-de/), which the player does not take.
const PATH =
  /^\/(?:embed\/|intl-[a-z]{2}(?:-[A-Za-z]{2,4})?\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})\/?$/

export default defineProvider({
  name: 'Spotify',
  frames: [PLAYER],
  // The compact player.
  size: { height: 152 },
  embed(url) {
    const m = onHost(url, 'open.spotify.com') ? PATH.exec(url.pathname) : null
    return m ? `${PLAYER}${m[1]}/${m[2]}` : null
  },
  sandbox: ['allow-presentation'],
  // Without encrypted-media Spotify plays only previews.
  allow: ['autoplay', 'clipboard-write', 'encrypted-media', 'fullscreen', 'picture-in-picture'],
})
