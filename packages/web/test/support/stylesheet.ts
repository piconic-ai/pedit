import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** A stylesheet with its `@import "./x.css";` lines replaced by the file, as the build inlines them. */
export function readStylesheet(path: string): string {
  const text = readFileSync(path, 'utf8')
  return text.replace(/@import ["']([^"']+)["'];\n?/g, (_, rel: string) =>
    readStylesheet(resolve(dirname(path), rel)),
  )
}

/** The page's whole stylesheet (`src/style.css` and everything it imports). */
export function pageStylesheet(): string {
  return readStylesheet(resolve(import.meta.dirname, '../../src/style.css'))
}
