import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from '@codemirror/view'
import type { ShownThread } from './comments.ts'
import type { Readable, Store } from './store.ts'

const setMarks = StateEffect.define<DecorationSet>()

/**
 * Marks the text each open comment thread is on, and the thread in focus
 * more strongly. Clicking a mark puts its thread in focus. Between two
 * refreshes of the threads, the marks follow the edits.
 */
export function commentMarks(
  threads: Readable<readonly ShownThread[]>,
  focus: Store<string | null>,
): Extension {
  const build = (length: number) => marks(threads.get(), focus.get(), length)
  const field = StateField.define<DecorationSet>({
    create: (state) => build(state.doc.length),
    update(value, tr) {
      for (const e of tr.effects) if (e.is(setMarks)) return e.value
      return value.map(tr.changes)
    },
    provide: (f) => EditorView.decorations.from(f),
  })
  const sync = ViewPlugin.define((view) => {
    const redraw = () => view.dispatch({ effects: setMarks.of(build(view.state.doc.length)) })
    const stops = [threads.subscribe(redraw), focus.subscribe(redraw)]
    return { destroy: () => stops.forEach((stop) => stop()) }
  })
  const click = EditorView.domEventHandlers({
    mousedown(event) {
      const mark = (event.target as Element | null)?.closest?.('[data-thread]')
      const id = mark?.getAttribute('data-thread')
      if (id) focus.set(id)
      return false
    },
  })
  return [field, sync, click]
}

function marks(
  threads: readonly ShownThread[],
  focus: string | null,
  length: number,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const open = threads
    .filter((t) => !t.resolved && t.from >= 0 && t.from < t.to && t.to <= length)
    .sort((a, b) => a.from - b.from || a.to - b.to)
  for (const t of open) {
    builder.add(
      t.from,
      t.to,
      Decoration.mark({
        class: t.id === focus ? 'cm-comment cm-comment-focus' : 'cm-comment',
        attributes: { 'data-thread': t.id },
      }),
    )
  }
  return builder.finish()
}
