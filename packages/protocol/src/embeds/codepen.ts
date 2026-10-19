import { defineProvider, onHost } from './define.ts'

const PATH = /^\/([\w-]{1,64})\/(?:pen|embed|full|details)\/([A-Za-z0-9]{1,32})\/?$/
const TABS = /^(?:html|css|js|result)(?:,(?:html|css|js|result))?$/

export default defineProvider({
  name: 'CodePen',
  // Players live at /{user}/embed/{pen}, which no frame-src prefix can name, so
  // the frames are the whole origin; the preview still frames only the player
  // URLs embed() builds.
  frames: ['https://codepen.io/'],
  size: { ratio: '4/3' },
  embed(url) {
    const m = onHost(url, 'codepen.io') ? PATH.exec(url.pathname) : null
    if (!m) return null
    const tab = url.searchParams.get('default-tab')
    return `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=${tab && TABS.test(tab) ? tab : 'result'}`
  },
  // Pens commonly use forms and alert().
  sandbox: ['allow-forms', 'allow-modals'],
  allow: ['fullscreen', 'clipboard-write'],
})
