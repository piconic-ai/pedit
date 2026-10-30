// A browser-style guest of a room kept while its host is away: the real
// RoomClient (with the KeptAway client inside it), driven over stdin by
// kept_room_test.go. Every command answers with one JSON line of state.
// Usage: node kept-away.mjs <packages/protocol dir> <ws url> <key>
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
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
const metaDoc = new Y.Doc()
const awareness = new Awareness(doc)
awareness.setLocalState({ name: 'js guest' })
const statuses = []
let manifest = null
let metaId
let sync = 'kept'
let skipped = 0
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
  minBackoffMs: 100,
  maxBackoffMs: 500,
  onStatus: (s) => statuses.push(s),
  onKeptSkipped: (n) => {
    skipped = n
  },
  onKeptSync: (s) => {
    sync = s
  },
  // The ids of a live room and of a kept one differ: follow the manifest.
  onManifest: (files) => {
    manifest = files
    const next = protocol.metaFiles(files).get(0)
    if (next === metaId) return
    if (metaId !== undefined) client.removeFile(metaId)
    metaId = next
    if (metaId !== undefined) client.addFile(metaId, metaDoc, undefined, { comments: true })
  },
})
client.connect()

const text = doc.getText('content')
const send = () =>
  process.stdout.write(
    `${JSON.stringify({
      status: client.status,
      statuses,
      text: text.toString(),
      threads: [...metaDoc.getMap('comments').keys()],
      sync,
      skipped,
      replayed: client.kept.after !== undefined,
      keptUntil: client.keptUntil,
      closedByHost: client.closedByHost,
    })}\n`,
  )

for (let i = 0; i < 300 && (manifest === null || text.length === 0); i++) {
  await new Promise((r) => setTimeout(r, 50))
}
if (manifest === null) throw new Error('no manifest')
send()
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line)
  if (command.append) text.insert(text.length, command.append)
  if (command.thread) {
    const { from, to, quote, body } = command.thread
    const position = (index, assoc) =>
      Buffer.from(
        Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc)),
      ).toString('base64')
    metaDoc.transact(() => {
      const thread = new Y.Map()
      metaDoc.getMap('comments').set('thread1', thread)
      thread.set('anchor', { type: 'text', start: position(from, 0), end: position(to, -1) })
      thread.set('quote', quote)
      thread.set('resolved', false)
      const messages = new Y.Map()
      thread.set('messages', messages)
      messages.set('m1', { author: 'Ada', time: '2026-10-21T00:00:00.000Z', body })
    })
  }
  send()
}
await client.destroy()
