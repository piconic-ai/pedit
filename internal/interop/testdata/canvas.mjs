// A guest in a canvas room, as the web editor will be, driven by interop_test.go.
// Usage: node canvas.mjs <packages/protocol dir> <ws url> <key> <base> <next>
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [protocolDir, url, key, base, next] = process.argv.slice(2)

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
const replies = new Map()
const keys = await protocol.deriveRoomKeys(
  protocol.parseFragment(key),
  new URL(url).pathname.split('/')[3],
)
const client = new protocol.RoomClient({
  admissionToken: keys.editAdmission,
  url,
  keys,
  doc,
  awareness,
  onCanvas: (m) => replies.set(m.id, m),
})
client.connect()

async function until(what, cond) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const nodes = doc.getArray('nodes')
await until('the canvas', () => nodes.length > 0)
const host = [...awareness.getStates().values()].find((s) => s.role === 'host')
const first = nodes.get(0)
// Report the shape the host shared: a Y.Map per node, the text as a Y.Text.
process.stdout.write(
  `${JSON.stringify({
    format: host?.format,
    nodes: nodes.toJSON(),
    edges: doc.getArray('edges').toJSON(),
    textIsYText: first.get('text') instanceof Y.Text,
  })}\n`,
)

// Move a node and type into a text, as the canvas will.
doc.transact(() => {
  first.set('x', 1.5)
  first.get('text').insert(0, '居間: ')
})

// Then edit the JSON by hand.
client.sendCanvas({ kind: 'edit', id: 'j1', base, next })
await until('the reply', () => replies.has('j1'))
process.stdout.write(`${replies.get('j1').kind}\n`)
await client.destroy()
process.exit(0)
