/**
 * CSV and TSV as a projection of the shared text. The table never owns the
 * data: every cell remembers where it sits in the text, and every change is a
 * text edit, so sync, undo and the host's file stay as they are.
 */

export interface Cell {
  /** The cell's raw text in the file, quotes included: [from, to). */
  from: number
  to: number
  value: string
  quoted: boolean
}

export interface Row {
  /** Where the row starts, and where its content ends before the line break. */
  from: number
  to: number
  /** After the line break, or `to` for a last row without one. */
  end: number
  cells: Cell[]
}

export interface Table {
  delimiter: string
  /** The line break new rows use: the file's first one, or \n. */
  eol: string
  rows: Row[]
  /** The widest row. */
  columns: number
  /** The text this table was parsed from. */
  text: string
}

export class CsvError extends Error {
  constructor(
    message: string,
    /** 1-based line in the file. */
    readonly line: number,
  ) {
    super(message)
    this.name = 'CsvError'
  }
}

export interface Edit {
  from: number
  to: number
  insert: string
}

/** Comma for .csv, tab for .tsv, null for everything else. */
export function delimiterFor(file: string | undefined): string | null {
  const ext = /\.([^./\\]+)$/.exec(file ?? '')?.[1]?.toLowerCase()
  return ext === 'csv' ? ',' : ext === 'tsv' ? '\t' : null
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/**
 * Parses RFC 4180: fields may be quoted, quotes inside are doubled, and
 * quoted fields may span lines. A quote inside an unquoted field is kept as
 * text. A line break at the very end does not start another row.
 * Throws CsvError for an unclosed quote or text after a closing quote.
 */
export function parse(text: string, delimiter = ','): Table {
  const rows: Row[] = []
  const eol = /\r?\n/.exec(text)?.[0] ?? '\n'
  let i = 0
  while (i < text.length) {
    const row = parseRow(text, i, delimiter)
    rows.push(row)
    i = row.end
  }
  const columns = rows.reduce((n, r) => Math.max(n, r.cells.length), 0)
  return { delimiter, eol, rows, columns, text }
}

function isBreak(c: string | undefined): boolean {
  return c === '\n' || c === '\r'
}

/** One row starting at `from`, up to and including its line break. */
function parseRow(text: string, from: number, delimiter: string): Row {
  const cells: Cell[] = []
  let i = from
  for (;;) {
    const cell =
      text[i] === '"' ? parseQuoted(text, i, delimiter) : parseUnquoted(text, i, delimiter)
    cells.push(cell)
    i = cell.to
    if (text[i] !== delimiter) break
    i++
  }
  return { from, to: i, end: skipBreak(text, i), cells }
}

/** A quoted cell starting at the opening quote at `from`. */
function parseQuoted(text: string, from: number, delimiter: string): Cell {
  let value = ''
  let i = from + 1
  for (;;) {
    if (i >= text.length) {
      throw new CsvError('A quoted value is never closed', lineAt(text, from))
    }
    if (text[i] !== '"') {
      value += text[i]
      i++
    } else if (text[i + 1] === '"') {
      value += '"'
      i += 2
    } else {
      i++
      break
    }
  }
  if (i < text.length && text[i] !== delimiter && !isBreak(text[i])) {
    throw new CsvError('Text follows a closing quote', lineAt(text, i))
  }
  return { from, to: i, value, quoted: true }
}

function parseUnquoted(text: string, from: number, delimiter: string): Cell {
  let i = from
  while (i < text.length && text[i] !== delimiter && !isBreak(text[i])) i++
  return { from, to: i, value: text.slice(from, i), quoted: false }
}

/** Where the text continues after a line break (CRLF, LF or CR) at `i`. */
function skipBreak(text: string, i: number): number {
  if (text[i] === '\r' && text[i + 1] === '\n') return i + 2
  if (isBreak(text[i])) return i + 1
  return i
}

/** Parses, or returns the error instead of throwing it. */
export function tryParse(text: string, delimiter: string): Table | CsvError {
  try {
    return parse(text, delimiter)
  } catch (e) {
    if (e instanceof CsvError) return e
    throw e
  }
}

function needsQuotes(value: string, delimiter: string): boolean {
  return value.includes(delimiter) || /["\r\n]/.test(value)
}

/** A value as it goes in the file. A cell that was quoted stays quoted. */
export function encode(value: string, delimiter: string, quoted = false): string {
  if (!quoted && !needsQuotes(value, delimiter)) return value
  return `"${value.replaceAll('"', '""')}"`
}

/** The smallest edit turning `before` (at `offset` in the text) into `after`. */
function diff(before: string, after: string, offset: number): Edit[] {
  if (before === after) return []
  let start = 0
  const max = Math.min(before.length, after.length)
  while (start < max && before[start] === after[start]) start++
  let tail = 0
  while (
    tail < max - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }
  return [
    {
      from: offset + start,
      to: offset + before.length - tail,
      insert: after.slice(start, after.length - tail),
    },
  ]
}

function emptyRow(table: Table, columns = table.columns): string {
  return table.delimiter.repeat(Math.max(0, columns - 1))
}

/**
 * Sets one cell. Only the characters that changed are replaced, so two people
 * typing in the same cell merge like they do in the text editor. Cells past
 * the end of a short row, or rows past the end, are filled in.
 */
export function setCell(table: Table, row: number, col: number, value: string): Edit[] {
  const { delimiter } = table
  const r = table.rows[row]
  if (!r) {
    if (value === '') return []
    const missing = row - table.rows.length + 1
    const blank = Array.from({ length: missing - 1 }, () => '')
    const last = delimiter.repeat(col) + encode(value, delimiter)
    return appendLines(table, [...blank, last])
  }
  const cell = r.cells[col]
  if (cell) {
    // An unchanged value keeps its raw text, e.g. "a" where a would do.
    if (cell.value === value) return []
    const before = table.text.slice(cell.from, cell.to)
    return diff(before, encode(value, delimiter, cell.quoted), cell.from)
  }
  if (value === '') return []
  const pad = delimiter.repeat(col - r.cells.length + 1)
  return [{ from: r.to, to: r.to, insert: pad + encode(value, delimiter) }]
}

/**
 * Lines added after the last row. They start on a new line if the file does
 * not end with one, and end with a line break if the file did, or if the
 * last one is empty: without it, an empty last line would not be a row.
 */
function appendLines(table: Table, lines: string[]): Edit[] {
  const last = table.rows.at(-1)
  const endsWithBreak = last !== undefined && last.end !== last.to
  const lead = last && !endsWithBreak ? table.eol : ''
  const trail = endsWithBreak || lines.at(-1) === '' ? table.eol : ''
  const at = table.text.length
  return [{ from: at, to: at, insert: lead + lines.join(table.eol) + trail }]
}

/** Inserts an empty row before `index`; an index past the end appends. */
export function insertRow(table: Table, index: number): Edit[] {
  const r = table.rows[index]
  const line = emptyRow(table, Math.max(1, table.columns))
  if (!r) return appendLines(table, [line])
  return [{ from: r.from, to: r.from, insert: line + table.eol }]
}

export function deleteRow(table: Table, index: number): Edit[] {
  const r = table.rows[index]
  if (!r) return []
  const prev = table.rows[index - 1]
  // The last row has no line break of its own: take the one before it, unless
  // the row before is blank, which would then stop being a row.
  if (r.end === r.to && prev && prev.to > prev.from) {
    return [{ from: prev.to, to: r.to, insert: '' }]
  }
  if (r.end === r.to) return [{ from: r.from, to: r.to, insert: '' }]
  return [{ from: r.from, to: r.end, insert: '' }]
}

/** Inserts an empty column before `index` in every row that reaches it. */
export function insertColumn(table: Table, index: number): Edit[] {
  const { delimiter } = table
  const edits: Edit[] = []
  for (const r of table.rows) {
    const cell = r.cells[index]
    if (cell) edits.push({ from: cell.from, to: cell.from, insert: delimiter })
    else if (index === r.cells.length) edits.push({ from: r.to, to: r.to, insert: delimiter })
  }
  return edits
}

export function deleteColumn(table: Table, index: number): Edit[] {
  const edits: Edit[] = []
  for (const r of table.rows) {
    const cell = r.cells[index]
    if (!cell) continue
    const next = r.cells[index + 1]
    const prev = r.cells[index - 1]
    if (next) edits.push({ from: cell.from, to: next.from, insert: '' })
    else if (prev) edits.push({ from: prev.to, to: cell.to, insert: '' })
    else edits.push({ from: cell.from, to: cell.to, insert: '' })
  }
  return edits
}

/** The cell a text position falls in, e.g. someone's cursor in the text editor. */
export function cellAt(table: Table, index: number): { row: number; col: number } | null {
  for (let row = 0; row < table.rows.length; row++) {
    const r = table.rows[row] as Row
    if (index < r.from) return null
    if (index > r.to && index >= r.end) continue
    // A position on a delimiter belongs to the cell before it, one inside a
    // line break to the row's last cell.
    const col = r.cells.findIndex((c) => index <= c.to)
    return { row, col: col === -1 ? r.cells.length - 1 : col }
  }
  return null
}

/** Applies edits to a string; for tests and for checking edits before sending them. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text
  for (const e of [...edits].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to)
  }
  return out
}
