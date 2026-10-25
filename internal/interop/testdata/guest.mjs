// A guest built on the web client's RoomClient, driven by interop_test.go.
// Usage: node guest.mjs <packages/protocol dir> <ws url> <key>
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
const { deriveRoomKeys, parseFragment, RoomClient } = await import(
  pathToFileURL(join(protocolDir, 'src/index.ts')).href
)

const doc = new Y.Doc()
const text = doc.getText('content')
const awareness = new Awareness(doc)
awareness.setLocalState({ name: 'js guest' })
// Exercise Node's headers + protocols constructor as well as the browser-style
// protocols constructor used by the other interop guests.
const keys = await deriveRoomKeys(parseFragment(key), new URL(url).pathname.split('/')[3])
const client = new RoomClient({
  admissionToken: keys.readAdmission,
  url,
  keys,
  doc,
  awareness,
  headers: { 'X-Pedit-Test': 'interop' },
})
client.connect()

async function until(what, cond) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(text.toString())}`)
}

await until('the document', () => text.toString().includes('world'))
await until('the host', () =>
  [...awareness.getStates().values()].some((s) => s.role === 'host' && s.file === 'notes.md'),
)
// Offsets are UTF-16: insert right after the emoji (a surrogate pair), delete 'ん'.
const s = text.toString()
text.insert(s.indexOf(' world'), '[X]')
text.delete(s.indexOf('ん'), 1)
await until('the external edit', () => text.toString().includes('from file'))
process.stdout.write(`${JSON.stringify(text.toString())}\n`)
// The host stops next; its departure arrives as a null awareness state.
await until('the host to leave', () =>
  [...awareness.getStates().values()].every((s) => s.role !== 'host'),
)
process.stdout.write('host left\n')
await client.destroy()
process.exit(0)
