// The embed providers this relay frames, in the order the preview tries them.
// To add one, write <id>.ts next to this file with defineProvider and list it
// here; the id is the key. To drop one, remove its line and its file.
import codepen from './codepen.ts'
import type { Providers } from './define.ts'
import figma from './figma.ts'
import loom from './loom.ts'
import miro from './miro.ts'
import observable from './observable.ts'
import soundcloud from './soundcloud.ts'
import spotify from './spotify.ts'
import stackblitz from './stackblitz.ts'
import vimeo from './vimeo.ts'
import youtube from './youtube.ts'

export default {
  youtube,
  vimeo,
  loom,
  figma,
  codepen,
  stackblitz,
  observable,
  spotify,
  soundcloud,
  miro,
} satisfies Providers
