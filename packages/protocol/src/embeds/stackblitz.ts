import { defineProvider, onHost } from './define.ts'

const NAME = '[\\w-][\\w.-]{0,99}'
const PATH = new RegExp(
  `^/(?:edit/[\\w-]{1,100}|github/${NAME}/${NAME}(?:/tree(?:/${NAME}){1,20})?)/?$`,
)
// A file in the project: no empty, '.' or '..' segments.
const FILE = /^(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[\w.-]+(?:\/[\w.-]+){0,19}$/
const VIEW = /^(?:editor|preview|both)$/

export default defineProvider({
  name: 'StackBlitz',
  frames: ['https://stackblitz.com/edit/', 'https://stackblitz.com/github/'],
  size: { ratio: '4/3' },
  embed(url) {
    if (!onHost(url, 'stackblitz.com') || !PATH.test(url.pathname)) return null
    // Every segment of the path is checked above; the query is rebuilt.
    let src = `https://stackblitz.com${url.pathname.replace(/\/$/, '')}?embed=1`
    const file = url.searchParams.get('file')
    if (file && FILE.test(file)) src += `&file=${file}`
    const view = url.searchParams.get('view')
    if (view && VIEW.test(view)) src += `&view=${view}`
    return src
  },
  // Not allow-downloads, and not clipboard-read (define.ts): the clipboard may
  // hold this room's link, key and all.
  sandbox: ['allow-forms', 'allow-modals'],
  allow: ['cross-origin-isolated', 'clipboard-write', 'fullscreen'],
})
