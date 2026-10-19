// A guest in a room that shares several files, as the web editor will be,
// driven by interop_test.go.
// Usage: node files.mjs <packages/protocol dir> <ws url> <key>
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [protocolDir, url, key] = process.argv.slice(2)

// Load the same ESM builds the protocol package itself resolves, so there is a
// single Yjs instance.
const require = createRequire(join(protocolDir, 'package.json'))
function esm(pkg, subpath) {
  const dir = dirname(require.resolve(`${pkg}/package.json`))
  const { exports } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const entry = exports[subpath]
  return import(pathToFileURL(join(dir, entry.import ?? entry.module ?? entry.default)).href)
}
const Y = await esm('yjs', '.')
const { Awareness } = await esm('y-protocols', './awareness')
const protocol = await import(pathToFileURL(join(protocolDir, 'src/index.ts')).href)

const doc = new Y.Doc()
const awareness = new Awareness(doc)
awareness.setLocalState({ role: 'guest' })
let manifest = null
const synced = new Set()
let stored = null
const client = new protocol.RoomClient({
  admissionToken: await protocol.deriveAdmissionToken(key),
  url,
  key: await protocol.importKey(key),
  doc,
  awareness,
  onManifest: (files) => {
    manifest = files
  },
  onFileSynced: (id) => synced.add(id),
  onFileAttachment: (id, a) => {
    if (a.kind === 'stored') stored = { id, path: a.path }
  },
})
client.connect()

async function until(what, cond) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

await until('the manifest', () => manifest !== null)
const docs = new Map()
for (const f of manifest) {
  const fileDoc = new Y.Doc()
  docs.set(f.id, fileDoc)
  client.addFile(f.id, fileDoc)
}
await until('every file', () => manifest.every((f) => synced.has(f.id)))
const texts = Object.fromEntries(
  manifest.map((f) => [f.path, docs.get(f.id).getText('content').toString()]),
)
process.stdout.write(
  `${JSON.stringify({ manifest, texts, room: doc.getText('content').toString() })}\n`,
)

// Edit the second file, and announce an image pasted into it.
const second = docs.get(manifest[1].id).getText('content')
second.insert(second.length, '- from JS\n')
client.sendFileAttachment(manifest[1].id, {
  kind: 'announce',
  hash: '0123456789abcdef0123456789abcdef',
  mime: 'image/png',
})
await until('the stored reply', () => stored !== null)
process.stdout.write(`stored ${stored.id} ${stored.path}\n`)
await client.destroy()
process.exit(0)
