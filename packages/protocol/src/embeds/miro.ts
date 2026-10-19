import { defineProvider, onHost } from './define.ts'

const PLAYER = 'https://miro.com/app/live-embed/'
// Board ids often end in '=', which links may carry encoded.
const PATH = /^\/app\/(?:board|live-embed)\/([\w-]{8,40}={0,2})\/?$/

export default defineProvider({
  name: 'Miro',
  frames: [PLAYER],
  size: { ratio: '4/3' },
  embed(url) {
    if (!onHost(url, 'miro.com')) return null
    const m = PATH.exec(url.pathname.replace(/%3D/gi, '='))
    return m ? `${PLAYER}${m[1]}/` : null
  },
  // Forms for signing in to a board that is not public.
  sandbox: ['allow-forms'],
  allow: ['fullscreen'],
})
