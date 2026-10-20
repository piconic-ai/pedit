import { type Extension, StateEffect, StateField } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import * as Y from 'yjs'

export interface ImagePasteOptions {
  /**
   * Why images cannot be added right now, or null when they can: the host
   * must save images and the room must be open.
   */
  blocked: () => string | null
  /** Adds an image; resolves with the path to link to. */
  upload: (file: File) => Promise<string>
  onError: (message: string) => void
  /**
   * Holds the place an image goes outside the editor's state, which a room
   * that shares several files replaces when another file is shown: the
   * link then goes into the file it was added to, wherever it is. Without
   * it, the place is kept in the editor's state.
   */
  anchor?: (pos: number) => Anchor
}

/** A place in a document that follows every edit until something goes there. */
export interface Anchor {
  insert(text: string): void
}

const IMAGE = /^image\//

const addSlot = StateEffect.define<{ id: number; pos: number }>({
  map: ({ id, pos }, mapping) => ({ id, pos: mapping.mapPos(pos, -1) }),
})
const removeSlot = StateEffect.define<number>()

/**
 * Where each image being added will go. Positions follow every edit, local
 * or remote, until the image is ready; text typed right at a slot stays
 * after it.
 */
const slots = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value
    if (!tr.changes.empty) {
      next = new Map([...value].map(([id, pos]) => [id, tr.changes.mapPos(pos, -1)]))
    }
    for (const effect of tr.effects) {
      if (effect.is(addSlot)) next = new Map(next).set(effect.value.id, effect.value.pos)
      if (effect.is(removeSlot)) {
        next = new Map(next)
        ;(next as Map<number, number>).delete(effect.value)
      }
    }
    return next
  },
})

/**
 * A place in a shared text: it follows every edit, made here or by others,
 * while the text is shown or not. Text typed right at it stays after it, as
 * the editor's own slots do.
 */
export function textAnchor(text: Y.Text, pos: number): Anchor {
  const at = Y.createRelativePositionFromTypeIndex(text, pos, -1)
  return {
    insert(s) {
      const doc = text.doc
      const index = doc && Y.createAbsolutePositionFromRelativePosition(at, doc)?.index
      if (doc && index != null) doc.transact(() => text.insert(index, s))
    },
  }
}

/** Markdown for an image link. Angle brackets keep any path in one piece. */
export function imageMarkdown(path: string): string {
  return /[\s()<>]/.test(path) ? `![](<${path}>)` : `![](${path})`
}

let nextSlot = 0

/** Adds pasted and dropped images, linking each where it was put once it is saved. */
export function imagePaste(opts: ImagePasteOptions): Extension {
  const add = (view: EditorView, files: File[], pos: number) => {
    const blocked = opts.blocked()
    if (blocked) {
      opts.onError(blocked)
      return
    }
    for (const file of files) {
      const anchor = opts.anchor?.(pos)
      if (anchor) {
        opts.upload(file).then(
          (path) => anchor.insert(imageMarkdown(path)),
          (error: unknown) => opts.onError(error instanceof Error ? error.message : String(error)),
        )
        continue
      }
      const id = nextSlot++
      view.dispatch({ effects: addSlot.of({ id, pos }) })
      opts.upload(file).then(
        (path) => {
          const at = view.state.field(slots).get(id)
          if (at === undefined) return
          view.dispatch({
            changes: { from: at, insert: imageMarkdown(path) },
            effects: removeSlot.of(id),
          })
        },
        (error: unknown) => {
          view.dispatch({ effects: removeSlot.of(id) })
          opts.onError(error instanceof Error ? error.message : String(error))
        },
      )
    }
  }

  return [
    slots,
    EditorView.domEventHandlers({
      paste(event, view) {
        const data = event.clipboardData
        if (!data) return false
        const images = [...data.files].filter((f) => IMAGE.test(f.type))
        // Text wins: copying from a web page can carry both.
        if (images.length === 0 || data.types.includes('text/plain')) return false
        event.preventDefault()
        add(view, images, view.state.selection.main.head)
        return true
      },
      drop(event, view) {
        const files = [...(event.dataTransfer?.files ?? [])]
        if (files.length === 0) return false
        // Left to the browser, a dropped file opens in place of the page,
        // and the room's key in the URL goes with it.
        event.preventDefault()
        const images = files.filter((f) => IMAGE.test(f.type))
        if (images.length < files.length) opts.onError('Only images can be added.')
        if (images.length === 0) return true
        const pos =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
        add(view, images, pos)
        return true
      },
    }),
  ]
}
