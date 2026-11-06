/**
 * Where a comment can sit besides plain text: the cells of a table (CSV or
 * TSV, parsed by csv.ts) and the rows and columns they are in.
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

export interface Position {
  row: number
  col: number
}
