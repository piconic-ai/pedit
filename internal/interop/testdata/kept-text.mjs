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
const { encrypt } = await import(pathToFileURL(join(protocolDir, 'src/cipher.ts')).href)
const { KeptTextClient } = await import(pathToFileURL(join(protocolDir, 'src/kept-text.ts')).href)
const protocol = await import(pathToFileURL(join(protocolDir, 'src/index.ts')).href)
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
// What the last image command found: its content hash and whether the relay
// held it intact.
let image
const blobUrl = async (blobKeys, hash) =>
  `${url.origin}/api/rooms/${url.pathname.split('/')[2]}/blobs/${await protocol.blobIdFor(blobKeys, hash)}`
const send = () =>
  process.stdout.write(
    JSON.stringify({
      image,
      text: doc.getText('content').toString(),
      ...client.state,
      documents: Object.fromEntries(
        client.state.files
          .filter((file) => file.format === 'text')
          .map((file) => [file.id, client.getDoc(file.id).getText('content').toString()]),
      ),
      threads: Object.fromEntries(
        client.state.files
          .filter((file) => file.format === 'meta')
          .map((file) => [file.id, [...client.getDoc(file.id).getMap('comments').keys()]]),
      ),
    }) + '\n',
  )
send()
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line)
  if (command.append) {
    const target =
      command.file === undefined || command.file === 0 ? doc : client.getDoc(command.file)
    if (!target) throw new Error('unknown fixture file')
    target.getText('content').insert(target.getText('content').length, command.append)
    await client.flush()
  }
  if (command.thread) {
    // A comment on [from, to) of a file, as the web editor makes one.
    const { file = 0, from, to, quote, body } = command.thread
    const pairs = client.state.files
    const entry = pairs.find(
      (f) =>
        f.format === 'meta' &&
        f.path === `.pedit/meta/${pairs.find((p) => p.id === file).path}.json`,
    )
    const text = (file === 0 ? doc : client.getDoc(file)).getText('content')
    const position = (index, assoc) =>
      btoa(
        String.fromCharCode(
          ...Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index, assoc)),
        ),
      )
    const meta = client.getDoc(entry.id)
    meta.transact(() => {
      const thread = new Y.Map()
      meta.getMap('comments').set('thread1', thread)
      thread.set('anchor', { type: 'text', start: position(from, 0), end: position(to, -1) })
      thread.set('quote', quote)
      thread.set('resolved', false)
      const messages = new Y.Map()
      thread.set('messages', messages)
      messages.set('m1', { author: 'Ada', time: '2026-10-21T00:00:00.000Z', body })
    })
    await client.flush()
  }
  if (command.image || command.fetchImage) {
    const blobKeys = await protocol.deriveBlobKeys(
      keys.frameSecret,
      keys.editAdmission ?? keys.readAdmission,
    )
    const headers = { [protocol.ADMISSION_HEADER]: blobKeys.admission }
    if (command.image) {
      // Pasted in the browser: uploaded first, then linked in the text.
      const bytes = Uint8Array.from(atob(command.image), (c) => c.charCodeAt(0))
      const hash = await protocol.contentHash(bytes)
      const response = await fetch(await blobUrl(blobKeys, hash), {
        method: 'PUT',
        headers,
        body: await protocol.encryptBlob(blobKeys, bytes),
      })
      if (!response.ok) throw new Error(`could not upload the image: ${response.status}`)
      const text = doc.getText('content')
      text.insert(text.length, `\n![](assets/${hash}.png)`)
      await client.flush()
      image = { hash, ok: true }
    } else {
      const response = await fetch(await blobUrl(blobKeys, command.fetchImage), { headers })
      let ok = false
      if (response.ok) {
        try {
          await protocol.decryptBlob(
            blobKeys,
            new Uint8Array(await response.arrayBuffer()),
            command.fetchImage,
          )
          ok = true
        } catch {}
      }
      image = { hash: command.fetchImage, ok, status: response.status }
    }
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
  if (command.extraRoot) {
    const extra = new Y.Doc()
    extra.getMap('extra').set('value', 'unsupported')
    const update = Y.encodeStateAsUpdate(extra)
    extra.destroy()
    const domain = new TextEncoder().encode('pedit kept text v1\0')
    const message = new Uint8Array(domain.length + update.length)
    message.set(domain)
    message.set(update, domain.length)
    const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.signer.key, message))
    const plain = new Uint8Array(message.length + signature.length)
    plain.set(message)
    plain.set(signature, message.length)
    const response = await fetch(
      `${url.origin}/api/rooms/${url.pathname.split('/')[2]}/keep/append`,
      {
        method: 'POST',
        headers: { 'X-Pedit-Admission': keys.editAdmission, 'X-Pedit-Sender': crypto.randomUUID() },
        body: await encrypt(keys.frameKey, plain),
      },
    )
    if (!response.ok) throw new Error('could not insert unsupported-root log entry')
  }
  if (command.replay && previous) await fetch(previous.input, previous.init)
  try {
    await client.refresh()
  } catch (error) {
    // The relay answered 410: report whether the host closed the room.
    if (typeof error?.byHost !== 'boolean') throw error
    process.stdout.write(JSON.stringify({ gone: true, byHost: error.byHost }) + '\n')
    continue
  }
  send()
}
client.close()
doc.destroy()
