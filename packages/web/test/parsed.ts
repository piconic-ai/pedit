import type * as Y from 'yjs'
import { CsvError, type Table, tryParse } from '../src/csv.ts'
import { Store } from '../src/store.ts'

/** The text parsed as a table, as TableView.parsed keeps it, for tests. */
export function parsedAs(text: Y.Text, delimiter: string | null): Store<Table | null> {
  const parse = () => {
    const t = delimiter ? tryParse(text.toString(), delimiter) : null
    return t instanceof CsvError ? null : t
  }
  const table = new Store<Table | null>(parse())
  text.observe(() => table.set(parse()))
  return table
}
