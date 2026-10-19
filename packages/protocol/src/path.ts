/** Limits on a shared path, in bytes of UTF-8. */
export const MAX_PATH_BYTES = 1024
export const MAX_COMPONENT_BYTES = 255

/**
 * Why checkPath refuses a path. internal/protocol's CheckPath gives the same
 * answer for every path in packages/testdata/path-vectors.json.
 */
export type PathProblem =
  | 'empty'
  | 'too-long'
  | 'encoding'
  | 'backslash'
  | 'control'
  | 'bidi'
  | 'absolute'
  | 'component'
  | 'component-too-long'
  | 'character'
  | 'trailing'
  | 'reserved'

const utf8 = new TextEncoder()
const bytes = (s: string) => utf8.encode(s).length

/**
 * Whether `path` may name a file shared in a room, whatever the platform of
 * the host or of a guest that writes it: null, or the first problem found. A
 * path is relative and "/"-separated, with no empty, "." or ".." component,
 * and no name Windows or macOS would read differently from Linux: no "\",
 * control or bidi characters, reserved device names, ":" (an NTFS stream) or
 * <>"|?*, and no component ending in a dot or a space.
 */
export function checkPath(path: string): PathProblem | null {
  if (path === '') return 'empty'
  if (bytes(path) > MAX_PATH_BYTES) return 'too-long'
  // A lone surrogate has no UTF-8 (TextEncoder counts it as U+FFFD).
  if (/\p{Cs}/u.test(path)) return 'encoding'
  for (const c of path) {
    if (c === '\\') return 'backslash'
    if (/\p{Cc}/u.test(c)) return 'control'
    if (/\p{Bidi_Control}/u.test(c)) return 'bidi'
  }
  if (path.startsWith('/')) return 'absolute'
  for (const c of path.split('/')) {
    const problem = checkComponent(c)
    if (problem) return problem
  }
  return null
}

function checkComponent(c: string): PathProblem | null {
  if (c === '' || c === '.' || c === '..') return 'component'
  if (bytes(c) > MAX_COMPONENT_BYTES) return 'component-too-long'
  if (/[:<>"|?*]/.test(c)) return 'character'
  if (c.endsWith('.') || c.endsWith(' ')) return 'trailing'
  if (reservedOnWindows(c)) return 'reserved'
  return null
}

/**
 * A device name, which Windows keeps whatever the case, the extension or the
 * spaces before it: "con", "CON.md", "Com1 .txt", "conin$". It counts the
 * superscript digits Windows takes as COM and LPT ports too. Only ASCII
 * letters are upper-cased, so no other letter folds into one.
 */
function reservedOnWindows(c: string): boolean {
  const stem = c
    .replace(/\..*/s, '')
    .replace(/ +$/, '')
    .replace(/[a-z]/g, (l) => l.toUpperCase())
  return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[0-9¹²³])$/.test(stem)
}
