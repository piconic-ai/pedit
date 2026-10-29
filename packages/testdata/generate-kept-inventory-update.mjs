import { writeFileSync } from 'node:fs'
import * as Y from '../protocol/node_modules/yjs/dist/yjs.mjs'

const d = new Y.Doc()
d.clientID = 17
d.getText('content').insert(0, 'hello')
const update = Y.encodeStateAsUpdate(d)
const paths = [
  'assets/00000000000000000000000000000000.png',
  'assets/ffffffffffffffffffffffffffffffff.jpg',
]
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const p = paths.map((s) => Buffer.from(s))
const wire = Buffer.concat([
  Buffer.from('pedit/v6/inventory-text-update\0'),
  Buffer.from([0]),
  u32(update.length),
  Buffer.from(update),
  u32(p.length),
  ...p.flatMap((x) => [u32(x.length), x]),
])
const a = new Y.Doc()
a.clientID = 18
Y.applyUpdate(a, update)
const b = new Y.Doc()
b.clientID = 19
Y.applyUpdate(b, update)
let vector = Y.encodeStateVector(a)
a.getText('content').insert(5, 'A')
const first = Y.encodeStateAsUpdate(a, vector)
vector = Y.encodeStateVector(b)
b.getText('content').insert(0, 'B')
const second = Y.encodeStateAsUpdate(b, vector)
vector = Y.encodeStateVector(a)
a.getText('content').delete(5, 1)
const deletion = Y.encodeStateAsUpdate(a, vector)
const withAsset = new Y.Doc()
withAsset.clientID = 20
Y.applyUpdate(withAsset, update)
vector = Y.encodeStateVector(withAsset)
withAsset.getText('content').insert(5, ' ' + paths[0])
const asset = Y.encodeStateAsUpdate(withAsset, vector)
const base64 = (x) => Buffer.from(x).toString('base64')
writeFileSync(
  new URL('./kept-inventory-update-vectors.json', import.meta.url),
  JSON.stringify(
    {
      update: base64(update),
      additions: paths,
      wire: base64(wire),
      first: base64(first),
      second: base64(second),
      deletion: base64(deletion),
      asset: base64(asset),
    },
    null,
    2,
  ) + '\n',
)
for (const doc of [d, a, b, withAsset]) doc.destroy()
