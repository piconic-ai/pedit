import { undoDepth } from '@codemirror/commands'
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
      editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: ' THIRD' } })
      if (
        editor.draft.hidden ||
        editor.draft.value !== `${firstEdit} SECOND THIRD` ||
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
      editor.view.dispatch({
        changes: [
          { from: 0, to: 1, insert: 'Z' },
          { from: editor.view.state.doc.length, insert: rejected },
        ],
      })
      for (let i = 0; i < 200 && editor.draft.hidden; i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (editor.draft.hidden || !editor.draft.value.endsWith(rejected))
        throw Error('rejected input lost')
      if (editor.view.state.doc.toString() !== controller.text())
        throw Error('rejected edit was not reverted')
      const base = editor.view.state.doc.toString()
      editor.view.dispatch({ changes: { from: 1, to: 3 } })
      if (editor.draft.value !== 'Z' + base.slice(3) + rejected)
        throw Error('draft dropped middle selection deletion')
      editor.view.dispatch({ changes: { from: 0, to: 1, insert: 'Q' } })
      if (editor.draft.value !== 'Q' + base.slice(3) + rejected)
        throw Error('overlapping replacement lost')
      editor.view.dispatch({ changes: { from: 0, to: 1 } })
      if (editor.draft.value !== base.slice(3) + rejected) throw Error('overlapping deletion lost')
      editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: ' AFTER' } })
      editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: ' MORE' } })
      if (editor.draft.value !== base.slice(3) + rejected + ' AFTER MORE')
        throw Error('input after capacity rejection was lost')
      editor.draft.setRangeText(
        ' DIRECT',
        editor.draft.value.length,
        editor.draft.value.length,
        'end',
      )
      if (!editor.draft.value.endsWith(' AFTER MORE DIRECT'))
        throw Error('draft is not directly editable')
      if (!editor.view.state.readOnly) throw Error('editor remained writable with unresolved draft')
      const editedDraft = editor.draft.value
      editor.view.dispatch({ changes: { from: 0, to: 1, insert: 'IGNORED' } })
      if (editor.draft.value !== editedDraft || editor.view.state.doc.toString() !== base)
        throw Error('programmatic editor change erased direct draft edits')
      if (!editor.status.textContent?.includes('ignored'))
        throw Error('rejected transaction was not reported')
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
      let remoteEditor = new TestKeptEditor(remoteController)
      await remoteEditor.applyRemote(Y.encodeStateAsUpdate(remoteDoc, vector))
      if (!remoteEditor.view.state.doc.toString().endsWith(' REMOTE'))
        throw Error('remote update not displayed')
      remoteEditor.view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          metaKey: /Mac|iPhone|iPad/.test(navigator.platform),
          ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform),
          bubbles: true,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (
        !remoteEditor.view.state.doc.toString().endsWith(' REMOTE') ||
        !remoteController.text().endsWith(' REMOTE')
      )
        throw Error('undo reversed remote content')
      if ((await remoteBox.operations(link, fixture.roomId, remoteSender)).length !== 0)
        throw Error('undo resent remote content')
      const remoteText = remoteController.text()
      remoteEditor.view.dispatch({
        changes: [
          { from: 0, insert: 'first' },
          { from: remoteText.length, insert: 'last' },
        ],
      })
      for (let i = 0; i < 200 && remoteEditor.draft.hidden; i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (remoteEditor.draft.hidden || remoteEditor.view.state.doc.toString() !== remoteText)
        throw Error('failed edit rollback did not retain remote content')
      if (undoDepth(remoteEditor.view.state) !== 0) throw Error('rollback entered undo history')
      const rejectedDraft = remoteEditor.draft.value
      remoteEditor.view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'z',
          metaKey: /Mac|iPhone|iPad/.test(navigator.platform),
          ctrlKey: !/Mac|iPhone|iPad/.test(navigator.platform),
          bubbles: true,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (
        remoteEditor.view.state.doc.toString() !== remoteText ||
        remoteController.text() !== remoteText ||
        remoteEditor.draft.value !== rejectedDraft ||
        (await remoteBox.operations(link, fixture.roomId, remoteSender)).length !== 0
      )
        throw Error('undo after rollback changed remote content or draft')
      remoteEditor.destroy()
      remoteEditor = new TestKeptEditor(remoteController)
      remoteEditor.view.dispatch({
        changes: { from: remoteEditor.view.state.doc.length, insert: ' LOCAL' },
      })
      for (let i = 0; i < 200 && !remoteController.text().endsWith(' REMOTE LOCAL'); i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (!remoteController.text().endsWith(' REMOTE LOCAL'))
        throw Error('local edit removed remote content')
      remoteEditor.view.contentDOM.dispatchEvent(
        new CompositionEvent('compositionstart', { bubbles: true }),
      )
      remoteEditor.view.dispatch({
        changes: { from: remoteEditor.view.state.doc.length, insert: '拼' },
      })
      remoteEditor.view.dispatch({
        changes: { from: remoteEditor.view.state.doc.length, insert: '音' },
      })
      if (remoteController.text().endsWith('拼音')) throw Error('composition committed prematurely')
      remoteEditor.view.contentDOM.dispatchEvent(
        new CompositionEvent('compositionend', { bubbles: true }),
      )
      for (let i = 0; i < 200 && !remoteController.text().endsWith('拼音'); i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (!remoteController.text().endsWith(' REMOTE LOCAL拼音')) throw Error('composition lost')
      remoteEditor.view.dispatch({
        changes: { from: remoteEditor.view.state.doc.length, insert: '😀' },
      })
      for (let i = 0; i < 200 && !remoteController.text().endsWith('😀'); i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      const end = remoteEditor.view.state.doc.length
      remoteEditor.view.dispatch({ changes: { from: end - 2, to: end, insert: '😁' } })
      for (let i = 0; i < 200 && !remoteController.text().endsWith('😁'); i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (!remoteController.text().endsWith(' REMOTE LOCAL拼音😁'))
        throw Error('Unicode replacement lost')
      const unchanged = remoteController.text()
      remoteEditor.view.dispatch({
        changes: [
          { from: 0, to: 1, insert: 'Q' },
          { from: unchanged.length, insert: ' split' },
        ],
      })
      for (let i = 0; i < 200 && remoteEditor.draft.hidden; i++)
        await new Promise((resolve) => setTimeout(resolve, 20))
      if (
        remoteEditor.draft.hidden ||
        remoteEditor.draft.value !== 'Q' + unchanged.slice(1) + ' split' ||
        remoteController.text() !== unchanged
      )
        throw Error('noncontiguous edit was not retained as a draft')
      remoteEditor.destroy()
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
    if (!remoteController.text().endsWith(' REMOTE LOCAL拼音😁'))
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
