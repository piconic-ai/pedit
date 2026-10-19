// The embed providers this relay frames, in the order the preview tries them.
// To add one, write <id>.ts next to this file with defineProvider and list it
// here; the id is the key. To drop one, remove its line and its file.
import type { Providers } from './define.ts'
import vimeo from './vimeo.ts'
import youtube from './youtube.ts'

export default { youtube, vimeo } satisfies Providers
