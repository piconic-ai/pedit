import { Annotation, ChangeSet, Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type {
  KeptEditController,
  KeptEditStatus,
} from '../../../protocol/src/kept-edit-controller.ts'
import { defaultSourceLanguage, sourceEditorExtensions } from '../../../web/src/source-editor.ts'

const internal = Annotation.define<boolean>()
const labels: Record<KeptEditStatus, string> = {
  idle: 'No local changes checked. Relay history, host save and deadline are unconfirmed.',
  pending: 'Changes pending. Relay history, host save and deadline are unconfirmed.',
  'relay-accepted':
    'Relay receipt recorded. Relay history, host save and deadline are unconfirmed.',
  failed:
    'Changes could not be sent or stored. Relay history, host save and deadline are unconfirmed.',
}

// Test-only entry: no public route or product editor is enabled by this harness.
export class TestKeptEditor {
  readonly view: EditorView
  readonly status = document.createElement('p')
  readonly draft = document.createElement('textarea')
  private readonly writable = new Compartment()
  private busy = false
  private composing = false
  private compositionChanges: ChangeSet | undefined
  private draftChanges: ChangeSet | undefined
  constructor(private readonly controller: KeptEditController) {
    this.status.setAttribute('role', 'status')
    this.draft.hidden = true
    const root = document.querySelector('#editor')!
    root.appendChild(this.status)
    root.appendChild(this.draft)
    this.view = new EditorView({
      parent: root,
      state: EditorState.create({
        doc: controller.text(),
        extensions: sourceEditorExtensions({
          vim: [],
          undo: [],
          language: defaultSourceLanguage(),
          theme: [],
          font: [],
          wrap: [],
          editable: this.writable.of(EditorState.readOnly.of(false)),
          collaboration: [],
          comments: [],
          paste: [],
          selection: [
            EditorState.transactionFilter.of((transaction) => {
              if (
                !transaction.docChanged ||
                (!this.busy && this.draft.hidden) ||
                this.composing ||
                transaction.annotation(internal)
              )
                return transaction
              if (this.draft.hidden) this.draftChanges = undefined
              const previous =
                this.draftChanges ?? ChangeSet.empty(transaction.startState.doc.length)
              if (
                !this.draft.hidden &&
                (previous.length !== transaction.startState.doc.length ||
                  previous.apply(transaction.startState.doc).toString() !== this.draft.value)
              ) {
                this.status.textContent =
                  'Editor change ignored. Continue editing the draft; host save and deadline are unconfirmed.'
                return []
              }
              const edits: { from: number; to: number; insert: string }[] = []
              transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
                const start = previous.mapPos(from, from === to ? 1 : -1)
                const end = previous.mapPos(to, 1)
                edits.push({ from: start, to: end, insert: inserted.toString() })
              })
              const mapped = ChangeSet.of(edits, previous.newLength)
              this.draftChanges = previous.compose(mapped)
              this.draft.value = this.draftChanges.apply(transaction.startState.doc).toString()
              this.draft.hidden = false
              queueMicrotask(() => this.draft.focus())
              this.setStatus('failed')
              return []
            }),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged || update.transactions.every((tr) => tr.annotation(internal)))
                return
              const desired = update.state.doc.toString()
              if (this.composing) {
                this.busy = true
                this.compositionChanges = this.compositionChanges
                  ? this.compositionChanges.compose(update.changes)
                  : update.changes
                this.setStatus('pending')
                return
              }
              this.busy = true
              this.setStatus('pending')
              queueMicrotask(() => {
                void this.apply(desired, update.changes)
              })
            }),
            EditorView.domEventHandlers({
              compositionstart: () => {
                if (!this.busy && this.draft.hidden) {
                  this.composing = true
                  this.busy = true
                }
              },
              compositionend: () => {
                if (!this.composing) return
                queueMicrotask(() => {
                  this.composing = false
                  const changes = this.compositionChanges
                  this.compositionChanges = undefined
                  if (changes) void this.apply(this.view.state.doc.toString(), changes)
                  else this.busy = false
                })
              },
            }),
          ],
        }),
      }),
    })
    this.setStatus('idle')
  }
  setStatus(value: KeptEditStatus): void {
    this.status.textContent = this.draft.hidden
      ? labels[value]
      : 'An edit could not be applied. Continue editing or copy it in the draft field. Relay history, host save and deadline are unconfirmed.'
  }
  private async apply(desired: string, changes: ChangeSet): Promise<void> {
    this.view.dispatch({ effects: this.writable.reconfigure(EditorState.readOnly.of(true)) })
    const before = this.controller.text()
    const edits: { from: number; to: number; insert: string }[] = []
    changes.iterChanges((from, to, _fromB, _toB, inserted) => {
      edits.push({ from, to, insert: inserted.toString() })
    })
    const splitPair = (index: number) =>
      index > 0 &&
      index < before.length &&
      /[\uD800-\uDBFF]/.test(before.charAt(index - 1)) &&
      /[\uDC00-\uDFFF]/.test(before.charAt(index))
    try {
      const edit = edits[0]
      if (
        edits.length !== 1 ||
        !edit ||
        splitPair(edit.from) ||
        splitPair(edit.to) ||
        new TextDecoder().decode(new TextEncoder().encode(edit.insert)) !== edit.insert
      )
        throw new Error('unsupported edit')
      await this.controller.replace(edit.from, edit.to, edit.insert)
    } catch {
      if (this.draft.hidden) {
        this.draft.value = desired
        this.draftChanges = changes
      } else {
        this.draftChanges = changes.compose(this.draftChanges ?? ChangeSet.empty(changes.newLength))
      }
      this.draft.hidden = false
      this.draft.focus()
      this.setStatus('failed')
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: this.controller.text() },
        annotations: [internal.of(true), Transaction.addToHistory.of(false)],
      })
    } finally {
      this.busy = false
      this.view.dispatch({
        effects: this.writable.reconfigure(EditorState.readOnly.of(!this.draft.hidden)),
      })
    }
  }
  async applyRemote(update: Uint8Array): Promise<void> {
    if (this.busy || !this.draft.hidden) throw new Error('edit or draft in progress')
    this.busy = true
    try {
      const delta = await this.controller.applyRemote(update)
      const changes: { from: number; to: number; insert: string }[] = []
      let offset = 0
      for (const part of delta) {
        if (part.retain) offset += part.retain
        if (part.delete) {
          changes.push({ from: offset, to: offset + part.delete, insert: '' })
          offset += part.delete
        }
        if (part.insert) {
          if (typeof part.insert !== 'string') throw new Error('invalid remote text')
          changes.push({ from: offset, to: offset, insert: part.insert })
        }
      }
      this.view.dispatch({
        changes,
        annotations: [internal.of(true), Transaction.addToHistory.of(false)],
      })
    } finally {
      this.busy = false
    }
  }
  destroy(): void {
    this.view.destroy()
    this.status.remove()
    this.draft.remove()
  }
}
