// @vitest-environment jsdom
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { lockedUndo } from '../src/lockedundo.ts'

const views: EditorView[] = []
afterEach(() => {
  for (const v of views.splice(0)) v.destroy()
})

describe('lockedUndo', () => {
  it('keeps Ctrl+Z from changing the text while locked, and undoes again after', () => {
    const doc = new Y.Doc()
    const text = doc.getText('content')
    text.insert(0, 'base')
    const undo = new Y.UndoManager(text)
    let locked = false
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          Prec.high(keymap.of(lockedUndo(yUndoManagerKeymap, () => locked))),
          yCollab(text, new Awareness(doc), { undoManager: undo }),
          // The lock the editor gets while the host is away.
          EditorState.readOnly.of(true),
        ],
      }),
    })
    views.push(view)
    // A local edit, made before the host went away.
    view.dispatch({ changes: { from: 4, insert: ' edit' } })
    expect(text.toString()).toBe('base edit')
    locked = true
    const press = (key: string, shiftKey = false) =>
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey, bubbles: true }),
      )
    press('z')
    expect(text.toString()).toBe('base edit')
    locked = false
    press('z')
    expect(text.toString()).toBe('base')
    locked = true
    press('z', true)
    press('y')
    expect(text.toString()).toBe('base')
  })
})
