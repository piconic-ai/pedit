// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { CsvError } from '../src/csv.ts'
import { columnName, describeError, keepCaret, TableErrors, TableView } from '../src/table.ts'

const views: TableView[] = []

afterEach(() => {
  for (const v of views.splice(0)) v.element.remove()
})

function setup(content: string, delimiter = ',') {
  const doc = new Y.Doc()
  const text = doc.getText('content')
  text.insert(0, content)
  const awareness = new Awareness(doc)
  awareness.setLocalState({ user: { name: 'Me', color: '#1f7a64' } })
  const undoManager = new Y.UndoManager(text)
  const errors: (CsvError | null)[] = []
  const view = new TableView(text, awareness, undoManager, {
    onError: (e) => errors.push(e),
  })
  document.body.append(view.element)
  views.push(view)
  view.setDelimiter(delimiter)
  view.active = true
  const grid = () =>
    [...view.element.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((c) =>
        // The cell's own text, not the name label of someone else in it.
        [...c.childNodes]
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent)
          .join(''),
      ),
    )
  const cell = (row: number, col: number) => {
    const el = view.element.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`)
    if (!el) throw new Error(`no cell ${row}:${col}`)
    return el
  }
  const editor = () => view.element.querySelector<HTMLTextAreaElement>('.cell-editor')
  const type = (value: string) => {
    const e = editor()
    if (!e) throw new Error('not editing')
    e.value = value
    e.dispatchEvent(new Event('input'))
  }
  const key = (target: Element, k: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
  const rightClick = (target: Element) =>
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
  const menuItems = () =>
    [...view.element.querySelectorAll<HTMLButtonElement>('.context-menu [role="menuitem"]')].map(
      (b) => b.firstChild?.textContent,
    )
  const pick = (label: string) => {
    const b = [
      ...view.element.querySelectorAll<HTMLButtonElement>('.context-menu [role="menuitem"]'),
    ].find((x) => x.firstChild?.textContent === label)
    if (!b) throw new Error(`no ${label}`)
    b.click()
  }
  const head = (kind: 'row' | 'col', index: number) => {
    const attr = kind === 'row' ? 'data-head-row' : 'data-head-col'
    const el = view.element.querySelector<HTMLElement>(`[${attr}="${index}"]`)
    if (!el) throw new Error(`no ${kind} head ${index}`)
    return el
  }
  const marks = () =>
    [...view.element.querySelectorAll<HTMLElement>('[data-mark]')].map(
      (el) =>
        `${el.dataset.row === undefined ? el.textContent : `${el.dataset.row}:${el.dataset.col}`}=${el.dataset.mark}`,
    )
  return {
    doc,
    text,
    awareness,
    undoManager,
    view,
    errors,
    grid,
    cell,
    editor,
    type,
    key,
    rightClick,
    menuItems,
    pick,
    head,
    marks,
  }
}

describe('TableView', () => {
  it('shows every row under lettered columns and numbered rows, padding short rows', () => {
    const { grid, view } = setup('name,city,zip\nAda,London\n')
    expect(grid()).toEqual([
      ['name', 'city', 'zip'],
      ['Ada', 'London', ''],
    ])
    const text = (sel: string) => [...view.element.querySelectorAll(sel)].map((e) => e.textContent)
    expect(text('.col-head')).toEqual(['A', 'B', 'C'])
    expect(text('.row-head')).toEqual(['1', '2'])
  })

  it('lights up the headers of the selected cell', () => {
    const { view, marks } = setup('a,b\nc,d\n')
    view.select({ row: 1, col: 1 })
    expect(marks()).toEqual(['B=active', '2=active'])
  })

  it('reads TSV with tabs', () => {
    const { grid } = setup('a\tb,c\n', '\t')
    expect(grid()).toEqual([['a', 'b,c']])
  })

  it('writes each keystroke of a cell edit to the text, quoting when needed', () => {
    const { text, view, type, editor } = setup('name,city\nAda,London\n')
    view.edit({ row: 1, col: 1 })
    expect(editor()?.value).toBe('London')
    type('London, UK')
    expect(text.toString()).toBe('name,city\nAda,"London, UK"\n')
    // Once quoted, a cell stays quoted, like a cell that was quoted in the file.
    type('Paris')
    expect(text.toString()).toBe('name,city\nAda,"Paris"\n')
  })

  it('keeps the typed text under the editor, so the cell keeps its size', () => {
    const { view, cell, type } = setup('a,b\n')
    view.edit({ row: 0, col: 1 })
    const mirror = cell(0, 1).querySelector('.cell-mirror')
    expect(mirror?.textContent).toBe('b\u200b')
    type('longer\n')
    expect(mirror?.textContent).toBe('longer\n\u200b')
    expect(cell(0, 1).lastElementChild?.className).toBe('cell-editor')
  })

  it('leaves the grid alone while typing in a cell, and shows the value after', () => {
    const { view, type, editor, key, cell } = setup('a,b\nc,d\n')
    view.edit({ row: 1, col: 0 })
    let redraws = 0
    view.shown.subscribe(() => redraws++)
    let moves = 0
    view.selection.subscribe(() => moves++)
    type('cat')
    type('cats')
    expect([redraws, moves]).toEqual([0, 0])
    key(editor() as HTMLElement, 'Enter')
    expect(cell(1, 0).textContent).toBe('cats')
  })

  it("republishes others' cells only when someone moves, not on an edit elsewhere", () => {
    const { doc, awareness, text, view, cell } = setup('a,b\nc,d\n')
    const other = new Awareness(new Y.Doc())
    const putGraceAt = (index: number) => {
      const pos = Y.createRelativePositionFromTypeIndex(doc.getText('content'), index)
      other.setLocalState({
        user: { name: 'Grace', color: '#4254b5' },
        cursor: { anchor: Y.relativePositionToJSON(pos), head: Y.relativePositionToJSON(pos) },
      })
      applyAwarenessUpdate(awareness, encodeAwarenessUpdate(other, [other.clientID]), 'remote')
    }
    putGraceAt(6) // in "d"
    let publishes = 0
    view.peers.subscribe(() => publishes++)

    // An edit in another cell leaves Grace in place.
    text.insert(0, 'x')
    expect(publishes).toBe(0)
    expect(cell(1, 1).dataset.peers).toBe('Grace')

    // Grace moves to "c": that is published.
    putGraceAt(5)
    expect(publishes).toBe(1)
    expect(cell(1, 0).dataset.peers).toBe('Grace')
    expect(cell(1, 1).dataset.peers).toBeUndefined()
  })

  it('types over a selected cell, like a spreadsheet', () => {
    const { text, view, cell, key } = setup('a,b\n')
    view.select({ row: 0, col: 1 })
    key(cell(0, 1), 'x')
    expect(text.toString()).toBe('a,x\n')
  })

  it('moves with the arrow keys and clears with Delete', () => {
    const { text, view, cell, key } = setup('a,b\nc,d\n')
    view.select({ row: 0, col: 0 })
    key(cell(0, 0), 'ArrowRight')
    key(cell(0, 1), 'ArrowDown')
    expect(view.selected).toEqual({ row: 1, col: 1 })
    key(cell(1, 1), 'Delete')
    expect(text.toString()).toBe('a,b\nc,\n')
  })

  it('moves down on Enter and right on Tab after an edit', () => {
    const { view, editor, key } = setup('a,b\nc,d\n')
    view.edit({ row: 0, col: 0 })
    key(editor() as HTMLElement, 'Enter')
    expect(editor()).toBeNull()
    expect(view.selected).toEqual({ row: 1, col: 0 })
    view.edit({ row: 1, col: 0 })
    key(editor() as HTMLElement, 'Tab')
    expect(view.selected).toEqual({ row: 1, col: 1 })
  })

  it('leaves Enter, Tab and Escape to the IME while it converts', () => {
    const { view, editor, key } = setup('a,b\nc,d\n')
    view.edit({ row: 0, col: 0 })
    for (const k of ['Enter', 'Tab', 'Escape'])
      key(editor() as HTMLElement, k, { isComposing: true })
    key(editor() as HTMLElement, 'Enter', { keyCode: 229 })
    expect(editor()).not.toBeNull()
    expect(view.selected).toEqual({ row: 0, col: 0 })
  })

  it('opens a selected cell as it is when an IME starts', () => {
    const { text, view, cell, key, editor } = setup('a,b\n')
    view.select({ row: 0, col: 1 })
    key(cell(0, 1), 'Process')
    expect(editor()?.value).toBe('b')
    expect(text.toString()).toBe('a,b\n')
  })

  it('edits on a second tap on a touch screen', () => {
    const { view, cell, editor } = setup('a,b\n')
    const tap = () => {
      const down = new MouseEvent('pointerdown', { bubbles: true })
      Object.defineProperty(down, 'pointerType', { value: 'touch' })
      cell(0, 1).dispatchEvent(down)
      cell(0, 1).click()
    }
    tap()
    expect(view.selected).toEqual({ row: 0, col: 1 })
    expect(editor()).toBeNull()
    tap()
    expect(editor()?.value).toBe('b')
  })

  it('edits on a double-click, not a second click, with a mouse', () => {
    const { cell, editor } = setup('a,b\n')
    cell(0, 1).click()
    cell(0, 1).click()
    expect(editor()).toBeNull()
    cell(0, 1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(editor()?.value).toBe('b')
  })

  it('leaves nothing behind after Escape, even after a pause, in a short row', async () => {
    const { text, view, type, editor, key, cell } = setup('a,b\nc\n')
    view.edit({ row: 1, col: 1 })
    type('x')
    // Longer than the undo manager's capture window.
    await new Promise((r) => setTimeout(r, 600))
    type('xy')
    key(editor() as HTMLElement, 'Escape')
    expect(text.toString()).toBe('a,b\nc\n')
    key(cell(1, 1), 'z', { ctrlKey: true })
    expect(text.toString()).toBe('a,b\nc\n')
    key(cell(1, 1), 'y', { ctrlKey: true })
    expect(text.toString()).toBe('a,b\nc\n')
  })

  it('puts the value back on Escape and moves up on Shift+Enter, as a spreadsheet does', () => {
    const { text, view, type, editor, key } = setup('a\nb\nc\n')
    view.edit({ row: 1, col: 0 })
    type('changed')
    expect(text.toString()).toBe('a\nchanged\nc\n')
    key(editor() as HTMLElement, 'Escape')
    expect(text.toString()).toBe('a\nb\nc\n')
    expect(editor()).toBeNull()
    expect(view.selected).toEqual({ row: 1, col: 0 })

    view.edit({ row: 1, col: 0 })
    key(editor() as HTMLElement, 'Enter', { shiftKey: true })
    expect(view.selected).toEqual({ row: 0, col: 0 })
  })

  it('breaks the line in a cell with Alt+Enter or Ctrl+Enter', () => {
    const { text, view, editor, key } = setup('ab\n')
    view.edit({ row: 0, col: 0 })
    const e = editor() as HTMLTextAreaElement
    e.setSelectionRange(1, 1)
    key(e, 'Enter', { ctrlKey: true })
    expect(text.toString()).toBe('"a\nb"\n')
    expect(editor()).not.toBeNull()
  })

  it('keeps the keyboard focus on the selected cell through a redraw', () => {
    const { text, view, cell } = setup('a,b\nc,d\n')
    view.select({ row: 1, col: 1 })
    expect(document.activeElement).toBe(cell(1, 1))
    text.insert(0, 'x')
    expect(document.activeElement).toBe(cell(1, 1))
  })

  it('moves the keyboard focus with the selected cell when someone adds a row above', () => {
    const { text, view, cell } = setup('h\na\nb\n')
    view.select({ row: 2, col: 0 })
    expect(document.activeElement).toBe(cell(2, 0))
    text.insert(2, 'new\n')
    expect(view.selected).toEqual({ row: 3, col: 0 })
    expect(document.activeElement).toBe(cell(3, 0))
  })

  it('carries an open edit over when someone adds a row above it', () => {
    const { text, view, type, editor } = setup('h\na\nb\n')
    view.edit({ row: 2, col: 0 })
    type('bee')
    ;(editor() as HTMLTextAreaElement).setSelectionRange(1, 1)
    text.insert(0, 'new\n')
    const moved = editor() as HTMLTextAreaElement
    expect(moved.closest('td')?.dataset.row).toBe('3')
    expect(moved.value).toBe('bee')
    expect(document.activeElement).toBe(moved)
    expect(moved.selectionStart).toBe(1)
    type('beet')
    expect(text.toString()).toBe('new\nh\na\nbeet\n')
  })

  it('keeps the selection on its cell when someone adds a row above', () => {
    const { text, view } = setup('h\na\nb\n')
    view.select({ row: 2, col: 0 })
    text.insert(2, 'new\n')
    expect(view.selected).toEqual({ row: 3, col: 0 })
  })

  it('shows what someone else types in the cell being edited', () => {
    const { text, view, editor } = setup('x,hello\n')
    view.edit({ row: 0, col: 1 })
    const e = editor() as HTMLTextAreaElement
    e.setSelectionRange(5, 5)
    text.insert(2, 'oh ')
    expect(e.value).toBe('oh hello')
    expect(e.selectionStart).toBe(8)
    expect(e.isConnected).toBe(true)
  })

  it('has no toolbar: rows and columns live in the context menu', () => {
    const { view } = setup('a\n')
    expect(view.element.querySelector('.table-tools')).toBeNull()
  })

  it('offers row and column actions on a right-clicked cell', () => {
    const { text, view, cell, rightClick, menuItems, pick } = setup('a,b\nc,d\n')
    rightClick(cell(1, 0))
    expect(view.selected).toEqual({ row: 1, col: 0 })
    expect(view.menu.open).toBe(true)
    expect(menuItems()).toEqual([
      'Insert row above',
      'Insert row below',
      'Delete row',
      'Insert column left',
      'Insert column right',
      'Delete column',
    ])
    pick('Insert row below')
    expect(view.menu.open).toBe(false)
    expect(text.toString()).toBe('a,b\nc,d\n,\n')
    expect(view.selected).toEqual({ row: 2, col: 0 })

    rightClick(cell(0, 1))
    pick('Insert column left')
    expect(text.toString()).toBe('a,,b\nc,,d\n,,\n')
    rightClick(cell(0, 1))
    pick('Delete column')
    rightClick(cell(2, 0))
    pick('Delete row')
    expect(text.toString()).toBe('a,b\nc,d\n')
  })

  it('offers only row actions on a row number, and selects the row', () => {
    const { text, view, head, rightClick, menuItems, pick, marks } = setup('a,b\nc,d\n')
    rightClick(head('row', 0))
    expect(menuItems()).toEqual(['Insert row above', 'Insert row below', 'Delete row'])
    expect(view.span).toBe('row')
    expect(marks()).toContain('1=selected')
    expect(marks()).toContain('0:1=span')
    pick('Insert row above')
    expect(text.toString()).toBe(',\na,b\nc,d\n')
    expect(view.span).toBe('row')
  })

  it('offers only column actions on a column letter, and selects the column', () => {
    const { text, view, head, rightClick, menuItems, pick } = setup('a,b\nc,d\n')
    rightClick(head('col', 1))
    expect(menuItems()).toEqual(['Insert column left', 'Insert column right', 'Delete column'])
    expect(view.span).toBe('column')
    pick('Delete column')
    expect(text.toString()).toBe('a\nc\n')
  })

  it('selects a row or a column by clicking its header', () => {
    const { view, head, marks } = setup('a,b\nc,d\n')
    head('col', 1).click()
    expect(view.span).toBe('column')
    expect(view.selected?.col).toBe(1)
    expect(marks().sort()).toEqual(['0:1=span', '1:1=span', '1=active', '2=active', 'B=selected'])
    head('row', 1).click()
    expect(view.span).toBe('row')
    expect(view.selected).toEqual({ row: 1, col: 1 })
  })

  it('inserts and deletes with Google Sheets shortcuts on a whole row or column', () => {
    const { text, view, cell, key } = setup('a,b\nc,d\n')
    view.select({ row: 1, col: 0 })
    // On a single cell Sheets asks what to insert; here the keys do nothing.
    key(cell(1, 0), '=', { code: 'Equal', ctrlKey: true, altKey: true })
    key(cell(1, 0), '-', { code: 'Minus', ctrlKey: true, altKey: true })
    expect(text.toString()).toBe('a,b\nc,d\n')
    key(cell(1, 0), ' ', { shiftKey: true })
    key(cell(1, 0), '=', { code: 'Equal', ctrlKey: true, altKey: true })
    expect(text.toString()).toBe('a,b\n,\nc,d\n')
    key(cell(1, 0), '-', { code: 'Minus', ctrlKey: true, altKey: true })
    expect(text.toString()).toBe('a,b\nc,d\n')
    // Ctrl+Space selects the column; then the same keys act on columns.
    key(cell(1, 0), ' ', { ctrlKey: true })
    expect(view.span).toBe('column')
    key(cell(1, 0), '≠', { code: 'Equal', metaKey: true, altKey: true })
    expect(text.toString()).toBe(',a,b\n,c,d\n')
    key(cell(1, 0), '–', { code: 'Minus', metaKey: true, altKey: true })
    expect(text.toString()).toBe('a,b\nc,d\n')
    // Shift+Space selects the row; an arrow key goes back to a single cell.
    key(cell(1, 0), ' ', { shiftKey: true })
    expect(view.span).toBe('row')
    key(cell(1, 0), 'ArrowUp')
    expect(view.span).toBe('cell')
  })

  it('shows the shortcuts only in the row and column menus, where they apply', () => {
    const { view, cell, head, rightClick } = setup('a,b\n')
    const kbd = () => [...view.element.querySelectorAll('.context-menu kbd')].length
    rightClick(cell(0, 0))
    expect(kbd()).toBe(0)
    rightClick(head('row', 0))
    expect(kbd()).toBe(2)
    rightClick(head('col', 0))
    expect(kbd()).toBe(2)
  })

  it('keeps deleting columns, or rows, when the delete keys are pressed again', () => {
    const { text, view, head, cell, key } = setup('a,b,c\nd,e,f\n')
    head('col', 1).click()
    key(cell(0, 1), '-', { code: 'Minus', ctrlKey: true, altKey: true })
    key(cell(0, 1), '-', { code: 'Minus', ctrlKey: true, altKey: true })
    expect(text.toString()).toBe('a\nd\n')
    expect(view.span).toBe('column')

    head('row', 0).click()
    key(cell(0, 0), '-', { code: 'Minus', ctrlKey: true, altKey: true })
    expect(view.span).toBe('row')
    expect(text.toString()).toBe('d\n')
  })

  it('clears a whole selected row with Delete', () => {
    const { text, view, head, cell, key } = setup('a,b\nc,d\n')
    head('row', 0).click()
    key(cell(0, 0), 'Delete')
    expect(text.toString()).toBe(',\nc,d\n')
  })

  it('opens the menu from the keyboard and closes it with Escape', () => {
    const { view, cell, key } = setup('a,b\n')
    view.select({ row: 0, col: 1 })
    key(cell(0, 1), 'F10', { shiftKey: true })
    expect(view.menu.open).toBe(true)
    const first = document.activeElement as HTMLElement
    expect(first.textContent).toContain('Insert row above')
    key(first, 'ArrowDown')
    expect(document.activeElement?.textContent).toContain('Insert row below')
    key(document.activeElement as HTMLElement, 'Escape')
    expect(view.menu.open).toBe(false)
    expect(document.activeElement).toBe(cell(0, 1))
  })

  it('opens the menu on a long press and ignores the tap that ends it', () => {
    vi.useFakeTimers()
    try {
      const { view, cell } = setup('a,b\nc,d\n')
      const press = (type: string) => {
        const ev = new MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5 })
        Object.defineProperty(ev, 'pointerType', { value: 'touch' })
        cell(1, 1).dispatchEvent(ev)
      }
      press('pointerdown')
      vi.advanceTimersByTime(600)
      expect(view.menu.open).toBe(true)
      expect(view.selected).toEqual({ row: 1, col: 1 })
      press('pointerup')
      cell(1, 1).click()
      // The finger lifting is not a second tap: nothing opens for editing.
      expect(view.element.querySelector('.cell-editor')).toBeNull()

      // Without a click after the long press, the next real tap still counts.
      press('pointerdown')
      vi.advanceTimersByTime(600)
      view.menu.close()
      press('pointerup')
      press('pointerdown')
      press('pointerup')
      cell(0, 0).click()
      expect(view.selected).toEqual({ row: 0, col: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives an empty file one cell to type into', () => {
    const { text, view, type, grid } = setup('')
    expect(grid()).toEqual([['']])
    view.edit({ row: 0, col: 0 })
    type('first')
    expect(text.toString()).toBe('first')
  })

  it('undoes the table edits with Ctrl+Z', () => {
    const { text, view, cell, key } = setup('a,b\n')
    view.select({ row: 0, col: 0 })
    key(cell(0, 0), 'Delete')
    expect(text.toString()).toBe(',b\n')
    key(cell(0, 0), 'z', { ctrlKey: true })
    expect(text.toString()).toBe('a,b\n')
  })

  it('reports when the file stops and starts parsing', () => {
    const { text, errors, grid } = setup('a,b\n')
    expect(errors).toEqual([])
    text.insert(4, '"open')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.line).toBe(2)
    expect(grid()).toEqual([])
    text.insert(9, '"')
    expect(errors.at(-1)).toBeNull()
    expect(grid()).toEqual([
      ['a', 'b'],
      ['open', ''],
    ])
  })

  it('tells others which cell is selected, through the text cursor', () => {
    const { doc, awareness, view } = setup('a,"b"\n')
    view.select({ row: 0, col: 1 })
    const cursor = awareness.getLocalState()?.cursor as { head: Y.RelativePosition }
    const at = Y.createAbsolutePositionFromRelativePosition(cursor.head, doc)
    // Just inside the opening quote, where a text cursor would be.
    expect(at?.index).toBe(3)
  })

  it('marks the cells other people are in', () => {
    const { doc, awareness, cell } = setup('a,b\nc,d\n')
    const other = new Awareness(new Y.Doc())
    const pos = Y.createRelativePositionFromTypeIndex(doc.getText('content'), 6)
    other.setLocalState({
      user: { name: 'Grace', color: '#4254b5' },
      cursor: { anchor: Y.relativePositionToJSON(pos), head: Y.relativePositionToJSON(pos) },
    })
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(other, [other.clientID]), 'remote')
    expect(cell(1, 1).dataset.peers).toBe('Grace')
    expect(cell(1, 1).querySelector('.cell-peer')?.textContent).toBe('Grace')
    expect(cell(0, 0).dataset.peers).toBeUndefined()
  })

  it('does not draw while inactive', () => {
    const { view, text, grid } = setup('a\n')
    view.active = false
    text.insert(2, 'b\n')
    expect(grid()).toEqual([['a']])
    view.active = true
    expect(grid()).toEqual([['a'], ['b']])
  })
})

describe('describeError', () => {
  it('names the line', async () => {
    const { tryParse } = await import('../src/csv.ts')
    const error = tryParse('a\n"b', ',') as CsvError
    expect(describeError(error)).toBe(
      'Shown as text: line 2 is not valid CSV (a quoted value is never closed).',
    )
  })
})

describe('keepCaret', () => {
  it('shifts the caret by a change before it and leaves it for a change after', () => {
    const e = document.createElement('textarea')
    e.value = 'hello'
    e.setSelectionRange(3, 3)
    keepCaret(e, 'oh hello')
    expect(e.selectionStart).toBe(6)
    e.setSelectionRange(2, 2)
    keepCaret(e, 'oh hello world')
    expect(e.selectionStart).toBe(2)
  })

  it('stays in range when text is removed', () => {
    const e = document.createElement('textarea')
    e.value = 'abcdef'
    e.setSelectionRange(6, 6)
    keepCaret(e, 'ab')
    expect(e.selectionStart).toBe(2)
  })
})

describe('columnName', () => {
  it.each([
    [0, 'A'],
    [25, 'Z'],
    [26, 'AA'],
    [51, 'AZ'],
    [52, 'BA'],
    [701, 'ZZ'],
    [702, 'AAA'],
  ])('%i -> %s', (index, name) => {
    expect(columnName(index)).toBe(name)
  })
})

describe('TableErrors', () => {
  const error = (line: number) => new CsvError('unclosed quote', line)

  it('shows only the error of the file on screen, and each file its own on showing it', () => {
    const shown: (number | null)[] = []
    const errors = new TableErrors(0, (e) => shown.push(e?.line ?? null))
    errors.report(0, error(3)) // a malformed table on screen
    errors.report(1, null) // a valid one, not on screen
    errors.report(2, error(5)) // another malformed one, not on screen
    expect(shown).toEqual([3])
    errors.show(1)
    errors.show(2)
    errors.show(0)
    expect(shown).toEqual([3, null, 5, 3])
    // A change to a file not on screen leaves the view alone.
    errors.report(1, error(9))
    expect(shown).toEqual([3, null, 5, 3])
    errors.show(1)
    expect(shown.at(-1)).toBe(9)
    errors.show(7) // never reported
    expect(shown.at(-1)).toBeNull()
  })
})
