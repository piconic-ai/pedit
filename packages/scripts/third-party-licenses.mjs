import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * License texts for packages that are licensed but do not ship the file,
 * copied from their repositories and keyed by the `repository` URL.
 */
const VENDORED = {
  'https://github.com/piconic-ai/barefootjs': 'barefootjs.txt',
  'https://github.com/uiwjs/react-codemirror': 'uiwjs-react-codemirror.txt',
}

/**
 * Packages whose published build inlines their dependencies, so the bundler
 * never sees those as modules of their own. Their dependencies are listed
 * too, all the way down, except the ones named here, which stay external.
 */
const INLINES = {
  '@barefootjs/xyflow': ['@barefootjs/client'],
}

/** Where `name` resolves from a package in `dir`, as Node.js would look for it. */
function findPackage(dir, name) {
  for (let d = dir; d !== dirname(d); d = dirname(d)) {
    const candidate = join(d, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

function repositoryUrl(pkg) {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  return url?.replace(/^git\+/, '').replace(/\.git$/, '')
}

function licenseText(dir, pkg) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f))
  if (file) return readFileSync(join(dir, file), 'utf8')
  const vendored = VENDORED[repositoryUrl(pkg)]
  return vendored && readFileSync(join(here, 'licenses', vendored), 'utf8')
}

/**
 * Builds a THIRD_PARTY_LICENSES text for the npm packages whose files were
 * bundled. `files` are module paths as reported by the bundler. `copied` lists
 * what was copied into the source instead, such as an icon's path, each with
 * a `header` and the `file` in licenses/ that holds the text it came under.
 */
export function thirdPartyLicenses(files, intro, copied = []) {
  const packages = new Map()
  const add = (dir, external = []) => {
    if (packages.has(dir)) return
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const header = `${pkg.name}@${pkg.version} (${pkg.license})`
    const text = licenseText(dir, pkg)
    if (!text) throw new Error(`no license file found for ${header}`)
    packages.set(dir, { header, text: text.trim() })
    const inlined = INLINES[pkg.name] ?? (external.length > 0 ? external : null)
    if (!inlined) return
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      // Type declarations are not code, so no build inlines them.
      if (inlined.includes(dep) || dep.startsWith('@types/')) continue
      const depDir = findPackage(dir, dep)
      if (!depDir) throw new Error(`${header} inlines ${dep}, which is not installed`)
      add(depDir, inlined)
    }
  }
  for (const file of files) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file.replace(/\\/g, '/'))
    if (match) add(resolve(match[1]))
  }
  for (const { header, file } of copied) {
    packages.set(`copied:${file}`, {
      header,
      text: readFileSync(join(here, 'licenses', file), 'utf8').trim(),
    })
  }
  const sections = [...packages.values()]
    .sort((a, b) => a.header.localeCompare(b.header))
    .map((p) => `${p.header}\n${'-'.repeat(p.header.length)}\n\n${p.text}\n`)
  return `${intro}\n\n${sections.join('\n')}`
}
