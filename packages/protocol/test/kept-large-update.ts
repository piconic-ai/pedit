import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import * as Y from 'yjs'
import { encodeMessage, MessageType } from '../src/message.ts'

export function largeKeptTextMessage(size: number): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, 'x'.repeat(size))
  const encoder = encoding.createEncoder()
  sync.writeUpdate(encoder, Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return encodeMessage(MessageType.Sync, encoding.toUint8Array(encoder))
}
