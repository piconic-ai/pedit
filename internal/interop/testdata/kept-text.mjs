// The browser's retained-text client, controlled by the interop test over stdin.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const [protocolDir, link] = process.argv.slice(2)
const require = createRequire(join(protocolDir, 'package.json'))
const yjs = dirname(require.resolve('yjs/package.json'))
const Y = await import(pathToFileURL(join(yjs, 'dist/yjs.mjs')).href)
const { deriveRoomKeys, parseFragment } = await import(
  pathToFileURL(join(protocolDir, 'src/access.ts')).href
)
const { KeptTextClient } = await import(pathToFileURL(join(protocolDir, 'src/kept-text.ts')).href)
const url = new URL(link)
const keys = await deriveRoomKeys(parseFragment(url.hash.slice(1)), url.pathname.split('/')[2])
const doc = new Y.Doc()
let previous
const client = new KeptTextClient({
  origin: url.origin,
  roomId: url.pathname.split('/')[2],
  keys,
  doc,
  fetch: async (input, init) => {
    if (init?.method === 'POST') previous = { input, init }
    return fetch(input, init)
  },
})
await client.refresh()
const send = () =>
  process.stdout.write(
    JSON.stringify({ text: doc.getText('content').toString(), ...client.state }) + '\n',
  )
send()
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line)
  if (command.append) {
    doc.getText('content').insert(doc.getText('content').length, command.append)
    await client.flush()
  }
  if (command.garbage) {
    const response = await fetch(
      `${url.origin}/api/rooms/${url.pathname.split('/')[2]}/keep/append`,
      {
        method: 'POST',
        headers: { 'X-Pedit-Admission': keys.editAdmission, 'X-Pedit-Sender': crypto.randomUUID() },
        body: Uint8Array.of(1),
      },
    )
    if (!response.ok) throw new Error('could not insert invalid log entry')
  }
  if (command.replay && previous) await fetch(previous.input, previous.init)
  await client.refresh()
  send()
}
client.close()
doc.destroy()
