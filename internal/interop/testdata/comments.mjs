// A guest that reads and writes comments (#121), as the web editor will,
// driven by interop_test.go.
// Usage: node comments.mjs <packages/protocol dir> <ws url> <key>
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [protocolDir, url, key] = process.argv.slice(2)

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
const keys = await protocol.deriveRoomKeys(
  protocol.parseFragment(key),
  new URL(url).pathname.split('/')[3],
)
const client = new protocol.RoomClient({
  admissionToken: keys.readAdmission,
  url,
  keys,
  doc,
  awareness,
  onManifest: (files) => {
    manifest = files
  },
  onFileSynced: (id) => synced.add(id),
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
const metaId = protocol.metaFiles(manifest).get(0)
if (metaId === undefined) throw new Error(`no metadata in ${JSON.stringify(manifest)}`)
const metaDoc = new Y.Doc()
client.addFile(metaId, metaDoc)
await until(
  'the text and the comments',
  () => doc.getText('content').toString().includes('world') && synced.has(metaId),
)

const text = doc.getText('content')
const fromBase64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'))
const toBase64 = (b) => Buffer.from(b).toString('base64')
const resolve = (s) =>
  Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(s)), doc, false)
    ?.index

// The thread the host loaded from disk, anchored where its text is now.
const loaded = metaDoc.getMap('comments').get('c1')
const anchor = loaded.get('anchor')
const start = resolve(anchor.start)
const end = resolve(anchor.end)
process.stdout.write(
  `${JSON.stringify({ quote: loaded.get('quote'), anchored: text.toString().slice(start, end) })}\n`,
)

// A new thread on "hello", as the editor makes one.
const at = text.toString().indexOf('hello')
const position = (index, assoc) =>
  toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc)))
metaDoc.transact(() => {
  const thread = new Y.Map()
  metaDoc.getMap('comments').set('g1', thread)
  thread.set('anchor', { type: 'text', start: position(at, 0), end: position(at + 5, -1) })
  thread.set('quote', 'hello')
  thread.set('resolved', false)
  const messages = new Y.Map()
  thread.set('messages', messages)
  messages.set('m1', { author: 'JS', time: new Date(0).toISOString(), body: 'Hi from JS' })
})
// The host stops next; its departure arrives as a null awareness state.
await until('the host to leave', () =>
  [...awareness.getStates().values()].every((s) => s.role !== 'host'),
)
process.stdout.write('host left\n')
await client.destroy()
process.exit(0)
