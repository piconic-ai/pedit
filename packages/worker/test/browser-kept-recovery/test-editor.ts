import { Annotation, ChangeSet, Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type {
  KeptEditController,
  KeptEditStatus,
} from '../../../protocol/src/kept-edit-controller.ts'

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
        extensions: [
          this.writable.of(EditorState.readOnly.of(false)),
          EditorState.transactionFilter.of((transaction) => {
            if (
              !transaction.docChanged ||
              (!this.busy && this.draft.hidden) ||
              transaction.annotation(internal)
            )
              return transaction
            if (this.draft.hidden) this.draftChanges = undefined
            const previous = this.draftChanges ?? ChangeSet.empty(transaction.startState.doc.length)
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
            this.busy = true
            this.setStatus('pending')
            queueMicrotask(() => {
              void this.apply(desired, update.changes)
            })
          }),
        ],
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
    let from = 0
    while (from < before.length && from < desired.length && before[from] === desired[from]) from++
    let a = before.length,
      b = desired.length
    while (a > from && b > from && before[a - 1] === desired[b - 1]) {
      a--
      b--
    }
    try {
      await this.controller.replace(from, a, desired.slice(from, b))
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
        annotations: internal.of(true),
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
      await this.controller.applyRemote(update)
      const next = this.controller.text()
      this.view.dispatch({
        changes: { from: 0, to: this.view.state.doc.length, insert: next },
        annotations: internal.of(true),
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
