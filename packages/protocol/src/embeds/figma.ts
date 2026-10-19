import { defineProvider, onHost } from './define.ts'

const TYPES = ['design', 'board', 'slides', 'deck', 'proto'] as const
// The legacy /file/ links open in Figma Design; a file's name after its key is left out.
const PATH = /^\/(design|board|slides|deck|proto|file)\/([A-Za-z0-9]{22,128})(?:\/[^/]{1,300})?\/?$/
const NODE = /^\d{1,10}[-:]\d{1,10}$/

export default defineProvider({
  name: 'Figma',
  frames: TYPES.map((type) => `https://embed.figma.com/${type}/` as const),
  // Designs and boards need room to be read in place.
  size: { ratio: '4/3' },
  embed(url) {
    const player = onHost(url, 'embed.figma.com')
    if (!player && !onHost(url, 'figma.com', 'www.figma.com')) return null
    const m = PATH.exec(url.pathname)
    if (!m || (player && m[1] === 'file')) return null
    const type = m[1] === 'file' ? 'design' : m[1]
    // Figma requires embed-host, naming the site the file is shown on.
    let src = `https://embed.figma.com/${type}/${m[2]}?embed-host=pedit`
    for (const name of ['node-id', 'starting-point-node-id']) {
      const node = url.searchParams.get(name)
      if (node && NODE.test(node)) src += `&${name}=${node}`
    }
    return src
  },
  // Forms for signing in to a file that is not public.
  sandbox: ['allow-forms'],
  allow: ['fullscreen', 'clipboard-write'],
})
