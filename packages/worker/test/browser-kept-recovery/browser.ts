import * as Y from 'yjs'
import { deriveKeptRoomKeys, parseKeptFragment } from '../../../protocol/src/kept-access.ts'
import {
  KeptEditController,
  type KeptEditStatus,
} from '../../../protocol/src/kept-edit-controller.ts'
import { KeptOutbox } from '../../../protocol/src/kept-outbox.ts'
import { KeptRoomClient } from '../../../protocol/src/kept-room-client.ts'
import fixture from '../../../testdata/kept-read-interop.json'
import shared from '../../../testdata/kept-recovery-wire.json'
import { TestKeptEditor } from './test-editor.ts'

const status = document.querySelector('#status')!
const link = parseKeptFragment(fixture.fragment)!
const epoch = Uint8Array.from(fixture.epoch.match(/../g)!, (x) => parseInt(x, 16))
const context = { roomId: fixture.roomId, epoch, generation: 1 }
const dbName = `pedit-test-${location.port}`
async function untilStatus(read: () => KeptEditStatus, expected: KeptEditStatus) {
  for (let i = 0; i < 200; i++) {
    if (read() === expected) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw Error(`status did not reach ${expected}: ${read()}`)
}
async function run() {
  try {
    const keys = await deriveKeptRoomKeys(link, fixture.roomId)
    const outbox = await KeptOutbox.open(dbName)
    if (location.search === '?autorun=first') {
      if ((await outbox.senders(link, fixture.roomId)).length) {
        outbox.close()
        return
      }
      const response = await fetch('/test/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: fixture.roomId,
          host: fixture.hostToken,
          editor: keys.editAdmission,
          commenter: keys.commentAdmission,
          reader: keys.readAdmission,
          checkpoint: fixture.checkpoint,
          epoch: fixture.epoch,
        }),
      })
      if (!response.ok) throw Error(`setup ${response.status}`)
      const sender = await outbox.createSender(link, fixture.roomId)
      const state = Uint8Array.from(
        atob(shared.textState.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0),
      )
      let current: KeptEditStatus = 'idle'
      const enqueue = outbox.enqueue.bind(outbox)
      let rejectPersistence = true
      outbox.enqueue = async (...args) => {
        if (rejectPersistence) {
          rejectPersistence = false
          throw Error('simulated storage failure')
        }
        return enqueue(...args)
      }
      let editor: TestKeptEditor | undefined
      const controller = await KeptEditController.open({
        url: location.origin,
        link,
        context,
        sender,
        outbox,
        baseline: state,
        onStatus: (value) => {
          current = value
          editor?.setStatus(value)
        },
        fetch: async (url, init) => {
          const response = await fetch(url, init)
          if (!response.ok) throw Error(`append ${response.status}`)
          throw Error('simulated response loss')
        },
      })
      let rejectedSecond = false
      try {
        await KeptEditController.open({
          url: location.origin,
          link,
          context,
          sender,
          outbox,
          baseline: state,
          onStatus: () => {},
        })
      } catch {
        rejectedSecond = true
      }
      if (!rejectedSecond) throw Error('concurrent writer admitted')
      editor = new TestKeptEditor(controller)
      editor.view.dispatch({
        changes: { from: editor.view.state.doc.length, insert: ' CRASH-EDIT' },
      })
      if (
        !editor.status.textContent?.includes('pending') ||
        !editor.status.textContent?.includes('deadline are unconfirmed')
      )
        throw Error('unsafe pending status')
      const firstEdit = editor.view.state.doc.toString()
      editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: ' SECOND' } })
      if (
        editor.draft.hidden ||
        editor.draft.value !== `${firstEdit} SECOND` ||
        editor.view.state.doc.toString() !== firstEdit
      )
        throw Error('concurrent input was not preserved as a draft')
      editor.draft.hidden = true
      editor.draft.value = ''
      editor.setStatus('pending')
      await untilStatus(() => current, 'failed')
      if ((await outbox.operations(link, fixture.roomId, sender)).length !== 0)
        throw Error('storage failure unexpectedly persisted edit')
      void controller.retry()
      await untilStatus(() => current, 'failed')
      if (!editor.status.textContent?.includes('unconfirmed')) throw Error('unsafe failure status')
      const rejected = 'x'.repeat(1_100_000)
      editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: rejected } })
      for (let i = 0; i < 200 && editor.draft.hidden; i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (editor.draft.hidden || !editor.draft.value.endsWith(rejected))
        throw Error('rejected input lost')
      if (editor.view.state.doc.toString() !== controller.text())
        throw Error('rejected edit was not reverted')
      editor.destroy()
      await controller.close()
      const ops = await outbox.operations(link, fixture.roomId, sender)
      if (ops[0]?.acknowledged !== false) throw Error('unexpected ack')
      outbox.close()
      const remoteBox = await KeptOutbox.open(`${dbName}-remote`)
      const remoteSender = await remoteBox.createSender(link, fixture.roomId)
      const remoteController = await KeptEditController.open({
        url: location.origin,
        link,
        context,
        sender: remoteSender,
        outbox: remoteBox,
        baseline: state,
        onStatus: () => {},
        fetch: async () => {
          throw Error('offline')
        },
      })
      const remoteDoc = new Y.Doc()
      Y.applyUpdate(remoteDoc, state)
      const vector = Y.encodeStateVector(remoteDoc)
      remoteDoc.getText('content').insert(remoteDoc.getText('content').length, ' REMOTE')
      await remoteController.applyRemote(Y.encodeStateAsUpdate(remoteDoc, vector))
      await remoteController.replace(
        remoteController.text().length,
        remoteController.text().length,
        ' LOCAL',
      )
      await remoteController.close()
      remoteDoc.destroy()
      remoteBox.close()
      // Keep a writer lock held until the harness kills Chrome.
      const crashBox = await KeptOutbox.open(dbName)
      await KeptEditController.open({
        url: location.origin,
        link,
        context,
        sender,
        outbox: crashBox,
        baseline: state,
        onStatus: () => {},
        fetch: async () => {
          throw Error('offline')
        },
      })
      status.textContent = 'PENDING: response lost after Room accepted'
      return
    }
    const remoteBox = await KeptOutbox.open(`${dbName}-remote`)
    const [remoteSender] = await remoteBox.senders(link, fixture.roomId)
    if (!remoteSender) throw Error('missing remote recovery sender')
    const remoteState = Uint8Array.from(
      atob(shared.textState.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    )
    const remoteController = await KeptEditController.open({
      url: location.origin,
      link,
      context,
      sender: remoteSender,
      outbox: remoteBox,
      baseline: remoteState,
      onStatus: () => {},
      fetch: async () => {
        throw Error('offline')
      },
    })
    if (!remoteController.text().endsWith(' REMOTE LOCAL'))
      throw Error('remote dependency not restored')
    await remoteController.close()
    remoteBox.close()
    const [sender] = await outbox.senders(link, fixture.roomId)
    if (!sender) throw Error('missing sender')
    const state = Uint8Array.from(
      atob(shared.textState.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    )
    let current: KeptEditStatus = 'idle'
    let editor: TestKeptEditor | undefined
    const controller = await KeptEditController.open({
      url: location.origin,
      link,
      context,
      sender,
      outbox,
      baseline: state,
      onStatus: (value) => {
        current = value
        editor?.setStatus(value)
      },
    })
    if (!controller.text().endsWith(' CRASH-EDIT'))
      throw Error('controller failed to restore local edit')
    editor = new TestKeptEditor(controller)
    editor.setStatus(current)
    await untilStatus(() => current, 'relay-accepted')
    if (
      !editor.status.textContent?.includes('Relay receipt') ||
      !editor.status.textContent?.includes('deadline are unconfirmed')
    )
      throw Error('unsafe relay receipt status')
    editor.destroy()
    await controller.close()
    outbox.close()
    const reopened = await KeptOutbox.open(dbName)
    const ops = await reopened.operations(link, fixture.roomId, sender)
    if (!ops[0]?.acknowledged) throw Error('ack not durable')
    reopened.close()
    const count = await (await fetch(`/test/count?id=${fixture.roomId}`)).text()
    if (count !== '1') throw Error(`wrong log count or ciphertext: ${count}`)
    const reader = new KeptRoomClient({
      url: location.origin,
      keys,
      attachmentInventory: async () => 'none',
    })
    const inspected = await reader.inspect()
    if (inspected.status !== 'tail-unverified' || inspected.applicable !== false)
      throw Error('wrong trust status')
    const restored = new Y.Doc()
    Y.applyUpdate(restored, inspected.textState)
    const initial = new Y.Doc()
    Y.applyUpdate(
      initial,
      Uint8Array.from(atob(shared.textState.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
        c.charCodeAt(0),
      ),
    )
    const expected = initial.getText('content').toString() + ' CRASH-EDIT'
    initial.destroy()
    if (restored.getText('content').toString() !== expected) throw Error('Yjs text mismatch')
    restored.destroy()
    status.textContent =
      'PASS: checkpoint and Yjs edit recovered after Chrome crash; tail unverified'
  } catch (e) {
    status.textContent = `FAIL: ${String(e)}`
  }
}
if (location.search === '?autorun=first' || location.search === '?autorun=retry') void run()
