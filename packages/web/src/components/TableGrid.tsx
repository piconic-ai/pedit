'use client'

import { createMemo } from '@barefootjs/client'
import { columnName, type TableView } from '../table.ts'

/**
 * Draws a TableView (table.ts) as a spreadsheet: lettered columns, numbered
 * rows, the selection, the cell being edited, and others' cells. Every event
 * goes back to the view, which keeps the state.
 */
export function TableGrid(props: { view: TableView }) {
  const v = props.view
  const table = () => v.shown.get()
  const selection = () => v.selection.get()
  const editing = () => v.editing.get()
  const mirror = () => v.mirror.get()
  const peers = () => v.peers.get()
  const commented = (row: number, col: number) =>
    v.commented.get().has(`${row}:${col}`) ? 'true' : undefined

  const columns = createMemo(() => {
    const t = table()
    return t ? Array.from({ length: Math.max(1, t.columns) }, (_, i) => i) : []
  })
  // Each row's values; an empty file still gets one cell to type into.
  const rows = createMemo(() => {
    const t = table()
    if (!t) return []
    return t.rows.length > 0 ? t.rows.map((r) => r.cells.map((c) => c.value)) : [[]]
  })

  // The headers of the cursor light up; a whole row or column is filled in.
  const colMark = (col: number) => {
    const s = selection()
    if (!s) return undefined
    if (s.at.col === col) return s.span === 'column' ? 'selected' : 'active'
    return s.span === 'row' ? 'active' : undefined
  }
  const rowMark = (row: number) => {
    const s = selection()
    if (!s) return undefined
    if (s.at.row === row) return s.span === 'row' ? 'selected' : 'active'
    return s.span === 'column' ? 'active' : undefined
  }
  const isCursor = (row: number, col: number) => {
    const s = selection()
    return !!s && s.at.row === row && s.at.col === col
  }
  const cellMark = (row: number, col: number) => {
    const s = selection()
    if (!s) return undefined
    if (s.span === 'row' && s.at.row === row) return 'span'
    if (s.span === 'column' && s.at.col === col) return 'span'
    return undefined
  }
  // Keeps the grid reachable with Tab even before anything was selected.
  const tabFor = (row: number, col: number) =>
    isCursor(row, col) || (!selection() && row === 0 && col === 0) ? 0 : -1
  const isEditing = (row: number, col: number) => {
    const e = editing()
    return !!e && e.row === row && e.col === col
  }
  const peerAt = (row: number, col: number) => peers()[`${row}:${col}`]

  return (
    <section className="table-view" aria-label="Table">
      <div className="table-scroll">
        <table
          className="grid"
          role="grid"
          onClick={(e) => v.onClick(e)}
          onDoubleClick={(e) => v.onDoubleClick(e)}
          onKeyDown={(e) => v.onKey(e)}
          onContextMenu={(e) => v.onContextMenu(e)}
          onPointerDown={(e) => v.onPointerDown(e)}
          onPointerMove={(e) => v.onPointerMove(e)}
          onPointerUp={() => v.onPointerEnd()}
          // onPointerCancel is not in @barefootjs/jsx's types.
          ref={(el) => el.addEventListener('pointercancel', () => v.onPointerEnd())}
        >
          <thead>
            <tr>
              <th className="grid-corner" aria-hidden="true" />
              {columns().map((col) => (
                <th
                  key={col}
                  className="col-head"
                  role="columnheader"
                  data-head-col={col}
                  data-mark={colMark(col)}
                >
                  {columnName(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows().map((values, row) => (
              <tr key={row}>
                <th
                  className="row-head"
                  role="rowheader"
                  data-head-row={row}
                  data-mark={rowMark(row)}
                >
                  {row + 1}
                </th>
                {columns().map((col) => (
                  <td
                    key={col}
                    role="gridcell"
                    data-row={row}
                    data-col={col}
                    tabindex={tabFor(row, col)}
                    aria-selected={isCursor(row, col) ? 'true' : undefined}
                    data-mark={cellMark(row, col)}
                    data-peers={peerAt(row, col)?.names}
                    data-comment={commented(row, col)}
                    style={peerAt(row, col) ? `--peer: ${peerAt(row, col)?.color}` : undefined}
                  >
                    {isEditing(row, col) ? (
                      <span className="cell-mirror" aria-hidden="true">
                        {mirror()}
                      </span>
                    ) : (
                      (values[col] ?? '')
                    )}
                    {isEditing(row, col) ? (
                      <textarea
                        className="cell-editor"
                        aria-label="Cell"
                        rows={1}
                        onInput={(e) => v.onEditorInput(e.currentTarget as HTMLTextAreaElement)}
                        onKeyDown={(e) => v.onEditorKey(e)}
                        onBlur={(e) => v.onEditorBlur(e.currentTarget as HTMLTextAreaElement)}
                      />
                    ) : null}
                    {peerAt(row, col) ? (
                      <span
                        className="cell-peer"
                        aria-hidden="true"
                        style={`background: ${peerAt(row, col)?.color}`}
                      >
                        {peerAt(row, col)?.names}
                      </span>
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="menu-host" ref={(el) => el.replaceChildren(v.menu.element)} />
    </section>
  )
}
