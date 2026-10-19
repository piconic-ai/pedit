import { defineProvider, onHost } from './define.ts'

const PLAYER = 'https://observablehq.com/embed/'
const PATH = /^\/(?:embed\/)?(@[\w-]{1,64}\/[\w-]{1,128})\/?$/
const CELLS = /^[A-Za-z_$][\w$]{0,63}(?:,[A-Za-z_$][\w$]{0,63}){0,31}$/

export default defineProvider({
  name: 'Observable',
  frames: [PLAYER],
  size: { ratio: '4/3' },
  embed(url) {
    const m = onHost(url, 'observablehq.com') ? PATH.exec(url.pathname) : null
    if (!m) return null
    // Only the named cells, if any: the whole notebook otherwise.
    const cells = url.searchParams.get('cells')
    return `${PLAYER}${m[1]}${cells && CELLS.test(cells) ? `?cells=${cells}` : ''}`
  },
  allow: ['fullscreen', 'clipboard-write'],
})
