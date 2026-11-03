// A browser guest in a canvas room that waits for a node's text, as the web
// editor would show it, driven by interop_test.go.
// Usage: node canvas-watch.mjs <packages/protocol dir> <ws url> <key> <text>
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [protocolDir, url, key, text] = process.argv.slice(2)

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
const keys = await protocol.deriveRoomKeys(
  protocol.parseFragment(key),
  new URL(url).pathname.split('/')[3],
)
const client = new protocol.RoomClient({ admissionToken: keys.editAdmission, url, keys, doc, awareness })
client.connect()

const nodes = doc.getArray('nodes')
const shown = () => nodes.toArray().map((n) => n.get('text')?.toString())
for (let i = 0; i < 200 && !shown().includes(text); i++) {
  await new Promise((r) => setTimeout(r, 50))
}
const first = nodes.get(0)
process.stdout.write(
  `${JSON.stringify({ texts: shown(), textIsYText: first?.get('text') instanceof Y.Text })}\n`,
)
await client.destroy()
process.exit(0)
