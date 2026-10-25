// A guest that pastes an image and fetches one it lacks, the way the web editor
// will, against a Go host. Driven by interop_test.go.
// Usage: node upload.mjs <packages/protocol dir> <server url> <room id> <key> <wanted hash>
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [protocolDir, server, room, key, wanted] = process.argv.slice(2)

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
const received = []
const keys = await protocol.deriveRoomKeys(protocol.parseFragment(key), room)
const client = new protocol.RoomClient({
  admissionToken: keys.editAdmission,
  url: `${server.replace(/^http/, 'ws')}/api/rooms/${room}/ws`,
  keys,
  doc,
  awareness,
  onAttachment: (a) => received.push(a),
})
client.connect()

async function until(what, cond) {
  for (let i = 0; i < 200; i++) {
    const value = cond()
    if (value) return value
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const blobKeys = await protocol.deriveBlobKeys(keys.frameSecret, keys.editAdmission)
const headers = { [protocol.ADMISSION_HEADER]: blobKeys.admission }
const blobUrl = async (hash) =>
  `${server}/api/rooms/${room}/blobs/${await protocol.blobIdFor(blobKeys, hash)}`

// Paste only once the host says it saves images.
await until('the host to offer attachments', () =>
  [...awareness.getStates().values()].some((s) => s.role === 'host' && s.attachments?.dir),
)

const png = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new TextEncoder().encode('pedit 居間'),
])
const hash = await protocol.contentHash(png)
const put = await fetch(await blobUrl(hash), {
  method: 'PUT',
  headers,
  body: await protocol.encryptBlob(blobKeys, png),
})
if (!put.ok) throw new Error(`upload failed: ${put.status}`)
client.sendAttachment({ kind: 'announce', hash, mime: 'image/png' })
const stored = await until('the stored reply', () =>
  received.find((a) => a.kind === 'stored' && a.hash === hash),
)
process.stdout.write(`stored ${stored.path}\n`)

// An image from an earlier session: not in the blob store until asked for.
if ((await fetch(await blobUrl(wanted), { headers })).status !== 404)
  throw new Error('expected a 404')
client.sendAttachment({ kind: 'want', hashes: [wanted] })
await until('the host to upload it', () =>
  received.some((a) => a.kind === 'announce' && a.hash === wanted),
)
const res = await fetch(await blobUrl(wanted), { headers })
const bytes = await protocol.decryptBlob(blobKeys, new Uint8Array(await res.arrayBuffer()), wanted)
const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
process.stdout.write(`wanted ${hex}\n`)
await client.destroy()
process.exit(0)
