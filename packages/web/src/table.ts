import { render } from '@barefootjs/client/runtime'
import type { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import {
  CsvError,
  cellAt,
  deleteColumn,
  deleteRow,
  type Edit,
  insertColumn,
  insertRow,
  setCell,
  type Table,
  tryParse,
} from './csv.ts'
import { ContextMenu, type MenuItem, SEPARATOR } from './menu.ts'
import { participants } from './room.ts'
import { Store } from './store.ts'
import './components/TableGrid.tsx'

/** Marks the table's own edits, so the undo manager tracks them and the view knows them. */
const TABLE_ORIGIN = Symbol('table')

export interface Position {
  row: number
  col: number
}

/** The selected cell, and whether its whole row or column is selected with it. */
export interface Selection {
  at: Position
  span: Span
}

/** Others in a cell: their names, and the colour of the first. */
export interface CellPeers {
  names: string
  color: string
}

/** What is selected around the cursor cell: the cell, its whole row, or its whole column. */
export type Span = 'cell' | 'row' | 'column'

/** What a right-click or long press landed on. */
export type Target =
  | { kind: 'cell'; at: Position }
  | { kind: 'row'; row: number }
  | { kind: 'column'; col: number }

const LONG_PRESS_MS = 550

/** Spreadsheet column names: A to Z, then AA, AB and on. */
export function columnName(index: number): string {
  let n = index + 1
  let name = ''
  while (n > 0) {
    const r = (n - 1) % 26
    name = String.fromCharCode(65 + r) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

/** The shortcuts, as in Google Sheets. */
export const SHORTCUTS = {
  insert: ['Mod', 'Alt', '='],
  remove: ['Mod', 'Alt', '-'],
} as const

export interface TableViewOptions {
  /** Called whenever the file starts or stops parsing, with why it does not. */
  onError?: (error: CsvError | null) => void
}

export function applyToText(text: Y.Text, edits: readonly Edit[], origin: unknown): void {
  if (edits.length === 0) return
  text.doc?.transact(() => {
    // From the end, so earlier positions stay valid.
    for (const e of [...edits].sort((a, b) => b.from - a.from)) {
      if (e.to > e.from) text.delete(e.from, e.to - e.from)
      if (e.insert) text.insert(e.from, e.insert)
    }
  }, origin)
}

/** Why the table cannot show, in a line fit for a tooltip. */
export function describeError(error: CsvError): string {
  return `Shown as text: line ${error.line} is not valid CSV (${error.message.toLowerCase()}).`
}

/**
 * CSV and TSV as a spreadsheet-like grid, with lettered columns and numbered
 * rows. Each change is written straight to the shared text (csv.ts), so the
 * table is only another way to look at the file. The selected cell is
 * remembered by its place in the text, so it stays put when someone adds a
 * row above it. Rows and columns are added and removed from a context menu
 * (right-click or long press) or with Google Sheets' shortcuts.
 *
 * This class keeps the state and the behaviour, and publishes what is on
 * screen as stores; components/TableGrid.tsx draws them inside `element` and
 * hands its events back here. Stores change the DOM synchronously, so the
 * methods can focus and measure cells right after setting them.
 */
export class TableView {
  readonly element: HTMLElement
  #text: Y.Text
  #awareness: Awareness
  #undo: Y.UndoManager
  #onError: (error: CsvError | null) => void
  #menu = new ContextMenu()
  /** The table on screen: the latest parse while active, left as it was while hidden. */
  readonly shown = new Store<Table | null>(null)
  readonly selection = new Store<Selection | null>(null)
  /** The cell being edited. */
  readonly editing = new Store<Position | null>(null)
  /** The edited text, drawn hidden under the editor so the cell keeps the size it would have. */
  readonly mirror = new Store('')
  /** Others' cells, keyed "row:col". */
  readonly peers = new Store<Readonly<Record<string, CellPeers>>>({})
  #span: Span = 'cell'
  /** Set after a long press opened the menu, so the tap that ends it does not select. */
  #swallowClick = false
  /** How the last press came: a second tap edits on a touch screen, not with a mouse. */
  #pointer = 'mouse'
  /** How many undo steps there were when the edit began, for Escape to go back to. */
  #undoDepth = 0
  #delimiter: string | null = null
  #table: Table | null = null
  #error: CsvError | null = null
  #active = false
  #selected: Position | null = null
  /** Where the selected cell starts in the text; null for a cell not in the file yet. */
  #anchor: Y.RelativePosition | null = null
  #editor: HTMLTextAreaElement | null = null
  #press: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null

  constructor(
    text: Y.Text,
    awareness: Awareness,
    undoManager: Y.UndoManager,
    options: TableViewOptions = {},
  ) {
    this.#text = text
    this.#awareness = awareness
    this.#undo = undoManager
    this.#undo.addTrackedOrigin(TABLE_ORIGIN)
    this.#onError = options.onError ?? (() => {})
    this.element = document.createElement('div')
    this.element.className = 'table-slot'
    render(this.element, 'TableGrid', { view: this })

    text.observe((event) => this.#onChange(event.transaction.origin === TABLE_ORIGIN))
    awareness.on('change', () => {
      if (this.#active) this.#paintPeers()
    })
  }

  get active(): boolean {
    return this.#active
  }

  set active(on: boolean) {
    this.#active = on
    if (!on) {
      this.#finishEdit(false)
      this.#menu.close()
    }
    this.#show()
  }

  get selected(): Position | null {
    return this.#selected && { ...this.#selected }
  }

  get span(): Span {
    return this.#span
  }

  get menu(): ContextMenu {
    return this.#menu
  }

  get table(): Table | null {
    return this.#table
  }

  /** The delimiter for the shared file, or null when it is not a table. */
  setDelimiter(delimiter: string | null): void {
    if (delimiter === this.#delimiter) return
    this.#delimiter = delimiter
    this.#parse()
    this.#show()
  }

  /** Moves the cursor to a cell; `span` widens the selection to its row or column. */
  select(at: Position, focus = true, span: Span = 'cell'): void {
    const row = Math.max(0, at.row)
    const col = Math.max(0, at.col)
    if (this.#editor) this.#finishEdit(false)
    this.#selected = { row, col }
    this.#span = span
    this.#anchor = this.#anchorFor(this.#selected)
    this.#publishCursor()
    this.selection.set({ at: { row, col }, span })
    this.#reveal(focus)
  }

  /** Starts editing a cell; `initial` replaces its value, as typing over a cell does. */
  edit(at: Position, initial?: string): void {
    if (!this.#table) return
    this.select(at, false)
    // The edit gets undo steps of its own, which Escape takes back.
    this.#undo.stopCapturing()
    this.#undoDepth = this.#undo.undoStack.length
    const value = initial ?? this.#valueAt(at)
    this.editing.set({ ...at })
    const editor = this.element.querySelector<HTMLTextAreaElement>('.cell-editor')
    if (!editor) return
    this.#editor = editor
    editor.value = value
    this.#fit()
    editor.focus()
    editor.setSelectionRange(value.length, value.length)
    if (initial !== undefined) this.#write(initial)
  }

  /** Inserts an empty row next to the cursor's and selects it. */
  insertRow(where: 'above' | 'below'): void {
    const table = this.#table
    if (!table) return
    const at = this.#selected ?? { row: 0, col: 0 }
    const row = where === 'above' ? at.row : at.row + 1
    this.#apply(insertRow(table, row))
    this.select({ row, col: at.col }, true, this.#span === 'row' ? 'row' : 'cell')
  }

  /** Inserts an empty column next to the cursor's and selects it. */
  insertColumn(where: 'left' | 'right'): void {
    const table = this.#table
    if (!table) return
    const at = this.#selected ?? { row: 0, col: 0 }
    const col = where === 'left' ? at.col : at.col + 1
    this.#apply(insertColumn(table, col))
    this.select({ row: at.row, col }, true, this.#span === 'column' ? 'column' : 'cell')
  }

  deleteRow(): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at || !table.rows[at.row]) return
    this.#apply(deleteRow(table, at.row))
    const rows = this.#table?.rows.length ?? 0
    // The row that takes its place stays selected the same way, so pressing
    // the delete keys again goes on deleting rows.
    const span = this.#span === 'row' ? 'row' : 'cell'
    this.select({ row: Math.min(at.row, Math.max(0, rows - 1)), col: at.col }, true, span)
  }

  deleteColumn(): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at || at.col >= table.columns) return
    this.#apply(deleteColumn(table, at.col))
    const cols = this.#table?.columns ?? 0
    const span = this.#span === 'column' ? 'column' : 'cell'
    this.select({ row: at.row, col: Math.min(at.col, Math.max(0, cols - 1)) }, true, span)
  }

  /** Opens the row and column menu for what was right-clicked or long-pressed. */
  openMenu(target: Target, x: number, y: number): void {
    if (this.#editor) this.#finishEdit(false)
    const cursor = this.#selected
    if (target.kind === 'row') {
      this.select({ row: target.row, col: cursor?.col ?? 0 }, true, 'row')
    } else if (target.kind === 'column') {
      this.select({ row: cursor?.row ?? 0, col: target.col }, true, 'column')
    } else if (!this.#inSelection(target.at)) {
      this.select(target.at)
    }
    this.#menu.show(this.#menuItems(target.kind), x, y)
  }

  #menuItems(kind: Target['kind']): (MenuItem | null)[] {
    const table = this.#table
    const at = this.#selected
    const { insert, remove } = SHORTCUTS
    // The shortcuts work on a whole selected row or column, as in Google Sheets.
    const rowKeys = kind === 'row'
    const columnKeys = kind === 'column'
    const rows: MenuItem[] = [
      {
        label: 'Insert row above',
        keys: rowKeys ? insert : undefined,
        action: () => this.insertRow('above'),
      },
      { label: 'Insert row below', action: () => this.insertRow('below') },
      {
        label: 'Delete row',
        keys: rowKeys ? remove : undefined,
        disabled: !(table && at && table.rows[at.row]),
        action: () => this.deleteRow(),
      },
    ]
    const columns: MenuItem[] = [
      {
        label: 'Insert column left',
        keys: columnKeys ? insert : undefined,
        action: () => this.insertColumn('left'),
      },
      { label: 'Insert column right', action: () => this.insertColumn('right') },
      {
        label: 'Delete column',
        keys: columnKeys ? remove : undefined,
        disabled: !(table && at && at.col < table.columns),
        action: () => this.deleteColumn(),
      },
    ]
    if (kind === 'row') return rows
    if (kind === 'column') return columns
    return [...rows, SEPARATOR, ...columns]
  }

  #inSelection(at: Position): boolean {
    const s = this.#selected
    if (!s) return false
    if (this.#span === 'row') return s.row === at.row
    if (this.#span === 'column') return s.col === at.col
    return s.row === at.row && s.col === at.col
  }

  // Events from the grid (components/TableGrid.tsx).

  onClick(ev: MouseEvent): void {
    this.#onClick(ev)
  }

  onDoubleClick(ev: MouseEvent): void {
    const at = this.#positionOf(ev.target)
    if (at) this.edit(at)
  }

  onKey(ev: KeyboardEvent): void {
    this.#onKey(ev)
  }

  onContextMenu(ev: MouseEvent): void {
    if ((ev.target as Element).closest?.('.cell-editor')) return
    const target = this.#targetOf(ev.target)
    if (!target) return
    ev.preventDefault()
    this.openMenu(target, ev.clientX, ev.clientY)
  }

  /** Touch screens: a long press opens the menu, as a right-click does. */
  onPointerDown(ev: PointerEvent): void {
    // The click that ends a long press, if the platform sends one, always
    // comes before the next press: a flag still set here was never used.
    this.#swallowClick = false
    this.#pointer = ev.pointerType
    if (ev.pointerType !== 'touch') return
    this.#cancelPress()
    const target = this.#targetOf(ev.target)
    if (!target || (ev.target as Element).closest?.('.cell-editor')) return
    const { clientX: x, clientY: y } = ev
    this.#press = {
      x,
      y,
      timer: setTimeout(() => {
        this.#press = null
        // Android also sends contextmenu for a long press; one menu is enough.
        if (this.#menu.open) return
        this.#swallowClick = true
        this.openMenu(target, x, y)
      }, LONG_PRESS_MS),
    }
  }

  onPointerMove(ev: PointerEvent): void {
    const press = this.#press
    if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) this.#cancelPress()
  }

  onPointerEnd(): void {
    this.#cancelPress()
  }

  #cancelPress(): void {
    if (this.#press) clearTimeout(this.#press.timer)
    this.#press = null
  }

  onEditorInput(editor: HTMLTextAreaElement): void {
    this.#write(editor.value)
    this.#fit()
  }

  onEditorKey(ev: KeyboardEvent): void {
    this.#onEditorKey(ev)
  }

  /** A blur that sticks ends the edit; one that comes back at once does not. */
  onEditorBlur(editor: HTMLTextAreaElement): void {
    setTimeout(() => {
      if (this.#editor === editor && document.activeElement !== editor) this.#finishEdit(false)
    })
  }

  /** Clears every cell in the selection. */
  #clear(): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at) return
    const cells: Position[] =
      this.#span === 'row'
        ? Array.from({ length: table.columns }, (_, col) => ({ row: at.row, col }))
        : this.#span === 'column'
          ? table.rows.map((_, row) => ({ row, col: at.col }))
          : [at]
    this.#apply(cells.flatMap((c) => setCell(table, c.row, c.col, '')))
  }

  #apply(edits: Edit[]): void {
    this.#undo.stopCapturing()
    applyToText(this.#text, edits, TABLE_ORIGIN)
    this.#undo.stopCapturing()
  }

  #write(value: string): void {
    const table = this.#table
    const at = this.#selected
    if (!table || !at) return
    applyToText(this.#text, setCell(table, at.row, at.col, value), TABLE_ORIGIN)
  }

  #onChange(local: boolean): void {
    this.#parse()
    if (local) {
      // Our own edit: the selection has not moved, but a new cell now has a place.
      if (this.#selected) this.#anchor = this.#anchorFor(this.#selected)
      // Typing in the open cell changes nothing else on screen: the editor shows
      // the text and the mirror sizes the cell, so the grid waits for the edit to end.
      if (this.#editor) return
    } else {
      this.#follow()
    }
    this.#show()
  }

  #parse(): void {
    const result = this.#delimiter ? tryParse(this.#text.toString(), this.#delimiter) : null
    const error = result instanceof CsvError ? result : null
    this.#table = result instanceof CsvError ? null : result
    const changed = error?.message !== this.#error?.message || error?.line !== this.#error?.line
    this.#error = error
    if (changed) this.#onError(error)
  }

  /** Moves the selection to where its cell went after someone else's edit. */
  #follow(): void {
    if (!this.#selected || !this.#anchor || !this.#table || !this.#text.doc) return
    const abs = Y.createAbsolutePositionFromRelativePosition(this.#anchor, this.#text.doc)
    const at = abs && cellAt(this.#table, abs.index)
    if (at) this.#selected = at
  }

  #anchorFor(at: Position): Y.RelativePosition | null {
    const cell = this.#table?.rows[at.row]?.cells[at.col]
    return cell ? Y.createRelativePositionFromTypeIndex(this.#text, cell.from) : null
  }

  #valueAt(at: Position): string {
    return this.#table?.rows[at.row]?.cells[at.col]?.value ?? ''
  }

  /** Shows others where we are: the start of the cell, like a cursor in the text. */
  #publishCursor(): void {
    const cell = this.#selected && this.#table?.rows[this.#selected.row]?.cells[this.#selected.col]
    if (!cell) return
    const pos = Y.createRelativePositionFromTypeIndex(this.#text, cell.from + (cell.quoted ? 1 : 0))
    this.#awareness.setLocalStateField('cursor', { anchor: pos, head: pos })
  }

  /** Puts the latest table on screen, while the view is active. */
  #show(): void {
    if (!this.#active) return
    const focused = document.activeElement
    const onCell = !!(focused as Element | null)?.closest?.('.grid [data-row]')
    this.shown.set(this.#table)
    const at = this.#selected
    const was = this.selection.get()
    // Only a moved selection is published, so the cells' selection effects stay put.
    if (at && (was?.at.row !== at.row || was.at.col !== at.col || was.span !== this.#span)) {
      this.selection.set({ at: { ...at }, span: this.#span })
    }
    if (at && this.#editor) {
      const moved = this.editing.get()
      // Someone else moved the cell being edited, e.g. by adding a row above:
      // the editor is drawn in its new place, so carry the typing over.
      if (moved && (moved.row !== at.row || moved.col !== at.col)) this.#moveEditor(at)
      // Someone else changed the cell being edited: show it, caret kept in place.
      const editor = this.#editor
      const value = this.#valueAt(at)
      if (editor && editor.value !== value) keepCaret(editor, value)
      this.#fit()
    } else if (onCell) {
      // The keyboard stays on the selected cell when someone else's edit moves it.
      this.#reveal(true)
    }
    this.#paintPeers()
  }

  #moveEditor(at: Position): void {
    const old = this.#editor
    if (!old) return
    const focused = document.activeElement === old
    const { value, selectionStart, selectionEnd } = old
    this.editing.set({ ...at })
    const next = this.element.querySelector<HTMLTextAreaElement>('.cell-editor')
    if (!next || next === old) return
    this.#editor = next
    next.value = value
    if (focused) {
      next.focus()
      next.setSelectionRange(selectionStart, selectionEnd)
    }
  }

  /** Brings the cursor cell into view, focusing it when asked and not editing. */
  #reveal(focus: boolean): void {
    const at = this.#selected
    const cell = at ? this.#cellElement(at) : null
    if (!cell) return
    if (focus && !this.#editor) cell.focus()
    cell.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  #paintPeers(): void {
    const table = this.#table
    const doc = this.#text.doc
    if (!table || !doc) {
      this.#setPeers({})
      return
    }
    const byCell: Record<string, CellPeers> = {}
    const states = this.#awareness.getStates()
    // Self by the awareness: a file of a room that shares several has a doc
    // of its own, with another client id.
    for (const p of participants(states, this.#awareness.clientID)) {
      if (p.isSelf) continue
      const cursor = (states.get(p.clientId) as { cursor?: { head?: unknown } } | undefined)?.cursor
      if (!cursor?.head) continue
      let index: number | undefined
      try {
        const rel = Y.createRelativePositionFromJSON(cursor.head)
        index = Y.createAbsolutePositionFromRelativePosition(rel, doc)?.index
      } catch {
        continue
      }
      const at = index === undefined ? null : cellAt(table, index)
      if (!at) continue
      const key = `${at.row}:${at.col}`
      const seen = byCell[key]
      byCell[key] = seen
        ? { names: `${seen.names}, ${p.name}`, color: seen.color }
        : { names: p.name, color: p.color }
    }
    this.#setPeers(byCell)
  }

  /** Publishes others' cells only when they moved, so the cells' peer effects stay put. */
  #setPeers(next: Record<string, CellPeers>): void {
    const prev = this.peers.get()
    const keys = Object.keys(next)
    const same =
      keys.length === Object.keys(prev).length &&
      keys.every((k) => prev[k]?.names === next[k]?.names && prev[k]?.color === next[k]?.color)
    if (!same) this.peers.set(next)
  }

  #cellElement(at: Position): HTMLElement | null {
    return this.element.querySelector<HTMLElement>(
      `.grid [data-row="${at.row}"][data-col="${at.col}"]`,
    )
  }

  #targetOf(target: EventTarget | null): Target | null {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>(
      '[data-row], [data-head-row], [data-head-col]',
    )
    if (!el?.closest('.grid')) return null
    if (el.dataset.headRow !== undefined) return { kind: 'row', row: Number(el.dataset.headRow) }
    if (el.dataset.headCol !== undefined) return { kind: 'column', col: Number(el.dataset.headCol) }
    return { kind: 'cell', at: { row: Number(el.dataset.row), col: Number(el.dataset.col) } }
  }

  #positionOf(target: EventTarget | null): Position | null {
    const cell = (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-row]')
    if (!cell?.closest('.grid')) return null
    return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) }
  }

  #onClick(ev: MouseEvent): void {
    if (this.#swallowClick) {
      this.#swallowClick = false
      return
    }
    if ((ev.target as HTMLElement).closest('.cell-editor')) return
    const target = this.#targetOf(ev.target)
    if (target?.kind === 'row') {
      this.select({ row: target.row, col: this.#selected?.col ?? 0 }, true, 'row')
      return
    }
    if (target?.kind === 'column') {
      this.select({ row: this.#selected?.row ?? 0, col: target.col }, true, 'column')
      return
    }
    const at = this.#positionOf(ev.target)
    if (!at) return
    const again =
      this.#span === 'cell' && this.#selected?.row === at.row && this.#selected.col === at.col
    // A mouse edits on a double-click, as in a spreadsheet. A second tap edits
    // on a touch screen, where a double tap may zoom instead.
    if (again && this.#pointer === 'touch') this.edit(at)
    else this.select(at)
  }

  #onKey(ev: KeyboardEvent): void {
    // Keys in the open cell are the editor's (#onEditorKey).
    if ((ev.target as Element).closest?.('.cell-editor') || this.#editor || !this.#selected) return
    const { row, col } = this.#selected
    const mod = ev.ctrlKey || ev.metaKey
    if (mod && ev.key.toLowerCase() === 'z') {
      ev.preventDefault()
      if (ev.shiftKey) this.#undo.redo()
      else this.#undo.undo()
      return
    }
    if (mod && ev.key.toLowerCase() === 'y') {
      ev.preventDefault()
      this.#undo.redo()
      return
    }
    // Google Sheets' keys: with a whole row or column selected, Ctrl+Alt+=
    // inserts one before it and Ctrl+Alt+- deletes it (⌘⌥ on a Mac). On a single
    // cell Sheets asks what to insert, so they do nothing here. The codes
    // survive ⌥ changing the character.
    if (mod && ev.altKey && (ev.code === 'Equal' || ev.code === 'Minus')) {
      ev.preventDefault()
      if (this.#span === 'cell') return
      const column = this.#span === 'column'
      if (ev.code === 'Equal') {
        if (column) this.insertColumn('left')
        else this.insertRow('above')
      } else if (column) this.deleteColumn()
      else this.deleteRow()
      return
    }
    if (ev.key === ' ' && (ev.shiftKey || ev.ctrlKey) && !ev.metaKey && !ev.altKey) {
      ev.preventDefault()
      this.select({ row, col }, true, ev.shiftKey ? 'row' : 'column')
      return
    }
    if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) {
      ev.preventDefault()
      const rect = this.#cellElement({ row, col })?.getBoundingClientRect()
      const target: Target =
        this.#span === 'row'
          ? { kind: 'row', row }
          : this.#span === 'column'
            ? { kind: 'column', col }
            : { kind: 'cell', at: { row, col } }
      this.openMenu(target, rect?.left ?? 0, rect?.bottom ?? 0)
      return
    }
    const rows = Math.max(1, this.#table?.rows.length ?? 0)
    const cols = Math.max(1, this.#table?.columns ?? 0)
    const moves: Record<string, Position> = {
      ArrowUp: { row: Math.max(0, row - 1), col },
      ArrowDown: { row: Math.min(rows - 1, row + 1), col },
      ArrowLeft: { row, col: Math.max(0, col - 1) },
      ArrowRight: { row, col: Math.min(cols - 1, col + 1) },
      Home: { row: mod ? 0 : row, col: 0 },
      End: { row: mod ? rows - 1 : row, col: cols - 1 },
    }
    const move = moves[ev.key]
    if (move) {
      ev.preventDefault()
      this.select(move)
    } else if (ev.key === 'Enter' || ev.key === 'F2') {
      ev.preventDefault()
      this.edit({ row, col })
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault()
      this.#clear()
    } else if (isComposing(ev)) {
      // An IME is starting: open the cell as it is, so the conversion lands in
      // the editor. Replacing the value would clear it if it did not.
      this.edit({ row, col })
    } else if (ev.key.length === 1 && !mod && !ev.altKey) {
      ev.preventDefault()
      this.edit({ row, col }, ev.key)
    }
  }

  #onEditorKey(ev: KeyboardEvent): void {
    const at = this.#selected
    // Keys that confirm or cancel an IME conversion belong to the IME. Safari
    // sends the confirming Enter just after compositionend, with keyCode 229.
    if (!at || isComposing(ev)) return
    const mod = ev.ctrlKey || ev.metaKey
    // The text is written as you type, so the textarea's own undo would lose track.
    if (mod && (ev.key.toLowerCase() === 'z' || ev.key.toLowerCase() === 'y')) {
      ev.preventDefault()
      if (ev.key.toLowerCase() === 'y' || ev.shiftKey) this.#undo.redo()
      else this.#undo.undo()
      return
    }
    // A line break inside the cell: Alt+Enter or Ctrl/⌘+Enter, as in Google Sheets.
    if (ev.key === 'Enter' && (ev.altKey || mod)) {
      ev.preventDefault()
      const editor = ev.target as HTMLTextAreaElement
      editor.setRangeText('\n', editor.selectionStart, editor.selectionEnd, 'end')
      this.#write(editor.value)
      this.#fit()
      return
    }
    if (ev.key === 'Escape') {
      // As in a spreadsheet, Escape drops the edit. Undoing it, rather than
      // writing the old value back, also removes a cell the typing created,
      // and leaves nothing for Ctrl+Z or Ctrl+Y to bring back.
      ev.preventDefault()
      this.#finishEdit(false)
      const redoDepth = this.#undo.redoStack.length
      while (this.#undo.undoStack.length > this.#undoDepth) this.#undo.undo()
      this.#undo.redoStack.splice(redoDepth)
      this.select(at)
      return
    }
    const next =
      ev.key === 'Enter'
        ? { row: Math.max(0, at.row + (ev.shiftKey ? -1 : 1)), col: at.col }
        : ev.key === 'Tab'
          ? { row: at.row, col: Math.max(0, at.col + (ev.shiftKey ? -1 : 1)) }
          : null
    if (!next) {
      this.#fit()
      return
    }
    ev.preventDefault()
    this.#finishEdit(true)
    const rows = Math.max(1, this.#table?.rows.length ?? 0)
    const cols = Math.max(1, this.#table?.columns ?? 0)
    this.select({ row: Math.min(rows - 1, next.row), col: Math.min(cols - 1, next.col) })
  }

  #finishEdit(focus: boolean): void {
    const editor = this.#editor
    if (!editor) return
    this.#editor = null
    this.#undo.stopCapturing()
    this.editing.set(null)
    // The grid skipped our own typing; show the cell as it is now.
    this.#show()
    if (focus) this.#reveal(true)
  }

  /** Sizes the cell to the text being typed; the editor fills the cell. */
  #fit(): void {
    const editor = this.#editor
    if (!editor) return
    // The zero-width space keeps a trailing line break's empty line.
    this.mirror.set(`${editor.value}\u200b`)
  }
}

function isComposing(ev: KeyboardEvent): boolean {
  return ev.isComposing || ev.key === 'Process' || ev.keyCode === 229
}

/** Replaces a textarea's value, keeping the caret on the same text around a change elsewhere. */
export function keepCaret(editor: HTMLTextAreaElement, value: string): void {
  const before = editor.value
  const caret = editor.selectionStart
  let start = 0
  while (start < before.length && start < value.length && before[start] === value[start]) start++
  editor.value = value
  const shifted = caret > start ? caret + (value.length - before.length) : caret
  const at = Math.max(0, Math.min(value.length, shifted))
  editor.setSelectionRange(at, at)
}
