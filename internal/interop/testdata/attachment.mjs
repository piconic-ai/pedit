// A guest that uploads an attachment the way the web editor will, driven by interop_test.go.
// Usage: node attachment.mjs <packages/protocol dir> <ws url> <key>
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
let stored = null
const keys = await protocol.deriveRoomKeys(
  protocol.parseFragment(key),
  new URL(url).pathname.split('/')[3],
)
const client = new protocol.RoomClient({
  admissionToken: keys.readAdmission,
  url,
  keys,
  doc,
  awareness: new Awareness(doc),
  onAttachment: (a) => {
    if (a.kind === 'stored') stored = a
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

const content = new TextEncoder().encode('pedit 居間')
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...content])
const blobKeys = await protocol.deriveBlobKeys(keys.frameSecret)
const hash = await protocol.contentHash(png)
const blobId = await protocol.blobIdFor(blobKeys, hash)
const blob = protocol.toBase64Url(await protocol.encryptBlob(blobKeys, png))

await until('the connection', () => client.status === 'connected')
client.sendAttachment({ kind: 'announce', hash, mime: 'image/png' })
process.stdout.write(`${JSON.stringify({ hash, blobId, blob })}\n`)
await until('the stored reply', () => stored?.hash === hash)
process.stdout.write(`stored ${stored.path}\n`)
await client.destroy()
process.exit(0)
