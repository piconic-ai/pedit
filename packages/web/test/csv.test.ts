import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  applyEdits,
  CsvError,
  cellAt,
  deleteColumn,
  deleteRow,
  delimiterFor,
  type Edit,
  encode,
  insertColumn,
  insertRow,
  parse,
  setCell,
  tryParse,
} from '../src/csv.ts'

const values = (text: string, delimiter = ',') =>
  parse(text, delimiter).rows.map((r) => r.cells.map((c) => c.value))

/** Runs an edit maker on the parsed text and returns the new text. */
function change(text: string, make: (t: ReturnType<typeof parse>) => Edit[], delimiter = ',') {
  return applyEdits(text, make(parse(text, delimiter)))
}

describe('delimiterFor', () => {
  it.each([
    ['data.csv', ','],
    ['DATA.CSV', ','],
    ['dir/list.tsv', '\t'],
    ['notes.md', null],
    ['csv', null],
    [undefined, null],
  ])('%s -> %j', (file, expected) => {
    expect(delimiterFor(file)).toBe(expected)
  })
})

describe('parse', () => {
  it('splits rows and cells, with a trailing line break ending the last row', () => {
    expect(values('a,b\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
    expect(values('a,b\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('reads quoted values with delimiters, doubled quotes and line breaks', () => {
    expect(values('"a,b","say ""hi""","two\nlines"\nx,y,z\n')).toEqual([
      ['a,b', 'say "hi"', 'two\nlines'],
      ['x', 'y', 'z'],
    ])
  })

  it('handles CRLF and remembers it for new rows', () => {
    const table = parse('a,b\r\nc,d\r\n')
    expect(table.eol).toBe('\r\n')
    expect(table.rows.map((r) => r.cells.map((c) => c.value))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('keeps empty cells, blank lines and ragged rows', () => {
    const table = parse('a,,c\n\nd\n')
    expect(table.rows.map((r) => r.cells.map((c) => c.value))).toEqual([
      ['a', '', 'c'],
      [''],
      ['d'],
    ])
    expect(table.columns).toBe(3)
  })

  it('has no rows for an empty file', () => {
    expect(parse('').rows).toEqual([])
  })

  it('records where every cell and row sits in the text', () => {
    const text = 'a,"b"\nc,d'
    const [first, second] = parse(text).rows
    expect(first?.cells.map((c) => text.slice(c.from, c.to))).toEqual(['a', '"b"'])
    expect(first?.cells[1]?.quoted).toBe(true)
    expect(first).toMatchObject({ from: 0, to: 5, end: 6 })
    expect(second).toMatchObject({ from: 6, to: 9, end: 9 })
  })

  it('reads tabs for TSV and leaves commas alone', () => {
    expect(values('a,b\tc\n', '\t')).toEqual([['a,b', 'c']])
  })

  it('keeps a quote inside an unquoted value as text', () => {
    expect(values('5" disk,x\n')).toEqual([['5" disk', 'x']])
  })

  it('ends a row at a lone CR, as at LF or CRLF', () => {
    const text = 'a,b\rc\r\nd\ne'
    const table = parse(text)
    expect(table.eol).toBe('\r\n')
    expect(table.rows.map((r) => [r.from, r.to, r.end])).toEqual([
      [0, 3, 4],
      [4, 5, 7],
      [7, 8, 9],
      [9, 10, 10],
    ])
    expect(values('"x"\r"y"\r')).toEqual([['x'], ['y']])
  })

  it('keeps an empty last cell after a trailing delimiter', () => {
    const [row] = parse('a,\n').rows
    expect(row?.cells.map((c) => [c.value, c.from, c.to])).toEqual([
      ['a', 0, 1],
      ['', 2, 2],
    ])
    expect(values('"",""')).toEqual([['', '']])
  })

  it('reads a quote-only value and a doubled quote at the end of the file', () => {
    expect(values('""""')).toEqual([['"']])
    expect(values('a,"b"""')).toEqual([['a', 'b"']])
    expect(() => parse('"a""')).toThrow('A quoted value is never closed')
    expect(() => parse('"a" ,b')).toThrow('Text follows a closing quote')
  })

  it('reports an unclosed quote and text after a closing quote with their line', () => {
    expect(() => parse('a\n"open,b\nc')).toThrow(CsvError)
    const unclosed = tryParse('a\n"open,b\nc', ',')
    expect(unclosed).toBeInstanceOf(CsvError)
    expect((unclosed as CsvError).line).toBe(2)
    const trailing = tryParse('a,b\n"x"y,z\n', ',')
    expect((trailing as CsvError).line).toBe(2)
  })
})

describe('encode', () => {
  it('quotes only when it has to, doubling quotes', () => {
    expect(encode('plain', ',')).toBe('plain')
    expect(encode('a,b', ',')).toBe('"a,b"')
    expect(encode('a,b', '\t')).toBe('a,b')
    expect(encode('say "hi"', ',')).toBe('"say ""hi"""')
    expect(encode('two\nlines', ',')).toBe('"two\nlines"')
  })

  it('keeps a quoted cell quoted', () => {
    expect(encode('plain', ',', true)).toBe('"plain"')
  })
})

describe('setCell', () => {
  it('replaces only the characters of that cell that changed', () => {
    const text = 'name,city\nAda,London\n'
    const edits = setCell(parse(text), 1, 1, 'Londinium')
    expect(edits).toEqual([{ from: 18, to: 20, insert: 'inium' }])
    expect(applyEdits(text, edits)).toBe('name,city\nAda,Londinium\n')
  })

  it('keeps the original quoting', () => {
    expect(change('"a",b\n', (t) => setCell(t, 0, 0, 'x'))).toBe('"x",b\n')
    expect(change('a,b\n', (t) => setCell(t, 0, 1, 'c'))).toBe('a,c\n')
  })

  it('adds quotes when the new value needs them', () => {
    expect(change('a,b\n', (t) => setCell(t, 0, 1, 'x,y'))).toBe('a,"x,y"\n')
    expect(change('a,b\n', (t) => setCell(t, 0, 0, 'say "hi"'))).toBe('"say ""hi""",b\n')
    expect(change('a,b\n', (t) => setCell(t, 0, 0, 'two\nlines'))).toBe('"two\nlines",b\n')
  })

  it('leaves the text alone when the value is the same', () => {
    expect(setCell(parse('"a",b'), 0, 0, 'a')).toEqual([])
  })

  it('fills in cells past the end of a short row', () => {
    expect(change('a,b,c\nd\n', (t) => setCell(t, 1, 2, 'f'))).toBe('a,b,c\nd,,f\n')
  })

  it('adds nothing for an empty value past the end', () => {
    expect(setCell(parse(''), 0, 0, '')).toEqual([])
    expect(setCell(parse('a\n'), 3, 1, '')).toEqual([])
  })

  it('adds rows past the end', () => {
    expect(change('a,b\n', (t) => setCell(t, 2, 1, 'x'))).toBe('a,b\n\n,x\n')
    expect(change('a,b', (t) => setCell(t, 1, 0, 'x'))).toBe('a,b\nx')
  })

  it('works on the right cell in a TSV file', () => {
    expect(change('a\tb\n', (t) => setCell(t, 0, 1, 'c,d'), '\t')).toBe('a\tc,d\n')
  })
})

describe('rows', () => {
  it('inserts an empty row with the table width before an index', () => {
    expect(change('h1,h2,h3\na,b,c\n', (t) => insertRow(t, 1))).toBe('h1,h2,h3\n,,\na,b,c\n')
  })

  it('appends, keeping whether the file ends with a line break', () => {
    expect(change('a,b\n', (t) => insertRow(t, 1))).toBe('a,b\n,\n')
    expect(change('a,b', (t) => insertRow(t, 1))).toBe('a,b\n,')
  })

  it('keeps an appended empty row in a one-column file', () => {
    const text = change('a', (t) => insertRow(t, 1))
    expect(values(text)).toEqual([['a'], ['']])
    expect(values(change('', (t) => insertRow(t, 0)))).toEqual([['']])
  })

  it('uses the file line break', () => {
    expect(change('a,b\r\nc,d\r\n', (t) => insertRow(t, 1))).toBe('a,b\r\n,\r\nc,d\r\n')
  })

  it('deletes a row with its line break', () => {
    expect(change('a\nb\nc\n', (t) => deleteRow(t, 1))).toBe('a\nc\n')
    expect(change('a\nb\nc', (t) => deleteRow(t, 2))).toBe('a\nb')
    expect(change('a', (t) => deleteRow(t, 0))).toBe('')
    expect(change('"x\ny",z\nb\n', (t) => deleteRow(t, 0))).toBe('b\n')
  })

  it('keeps a blank row before the last one', () => {
    const text = change('a\n\nb', (t) => deleteRow(t, 2))
    expect(text).toBe('a\n\n')
    expect(values(text)).toEqual([['a'], ['']])
  })
})

describe('columns', () => {
  it('inserts an empty column before an index in every row that reaches it', () => {
    expect(change('a,b\nc,d\ne\n', (t) => insertColumn(t, 1))).toBe('a,,b\nc,,d\ne,\n')
    expect(change('a,b\nc,d\n', (t) => insertColumn(t, 0))).toBe(',a,b\n,c,d\n')
    expect(change('a,b\nc,d\n', (t) => insertColumn(t, 2))).toBe('a,b,\nc,d,\n')
  })

  it('deletes a column with one of its delimiters', () => {
    expect(change('a,b,c\nd,e,f\n', (t) => deleteColumn(t, 1))).toBe('a,c\nd,f\n')
    expect(change('a,b,c\nd,e,f\n', (t) => deleteColumn(t, 2))).toBe('a,b\nd,e\n')
    expect(change('a,"b,x"\nc\n', (t) => deleteColumn(t, 1))).toBe('a\nc\n')
    expect(change('a\nb\n', (t) => deleteColumn(t, 0))).toBe('\n\n')
  })
})

describe('cellAt', () => {
  const text = 'a,bb\n"c\nd",e'
  const table = parse(text)

  it.each([
    [0, { row: 0, col: 0 }],
    [1, { row: 0, col: 0 }],
    [2, { row: 0, col: 1 }],
    [4, { row: 0, col: 1 }],
    [5, { row: 1, col: 0 }],
    [8, { row: 1, col: 0 }],
    [11, { row: 1, col: 1 }],
    [12, { row: 1, col: 1 }],
  ])('position %i is in %j', (index, expected) => {
    expect(cellAt(table, index)).toEqual(expected)
  })

  it('finds nothing past the end', () => {
    expect(cellAt(parse('a\n'), 2)).toBeNull()
  })
})

describe('concurrent edits', () => {
  function pair(text: string) {
    const a = new Y.Doc()
    a.getText('content').insert(0, text)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    return [a, b] as const
  }
  function apply(doc: Y.Doc, edits: Edit[]) {
    const ytext = doc.getText('content')
    doc.transact(() => {
      for (const e of [...edits].sort((x, y) => y.from - x.from)) {
        if (e.to > e.from) ytext.delete(e.from, e.to - e.from)
        if (e.insert) ytext.insert(e.from, e.insert)
      }
    })
  }
  function sync(a: Y.Doc, b: Y.Doc) {
    const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
    const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
    Y.applyUpdate(b, fromA)
    Y.applyUpdate(a, fromB)
  }

  it('merges edits to different cells', () => {
    const text = 'name,city\nAda,London\nGrace,New York\n'
    const [a, b] = pair(text)
    apply(a, setCell(parse(text), 1, 1, 'Cambridge'))
    apply(b, setCell(parse(text), 2, 1, 'Arlington, VA'))
    sync(a, b)
    const merged = a.getText('content').toString()
    expect(merged).toBe(b.getText('content').toString())
    expect(values(merged)).toEqual([
      ['name', 'city'],
      ['Ada', 'Cambridge'],
      ['Grace', 'Arlington, VA'],
    ])
  })

  it('merges a cell edit with a row inserted above it', () => {
    const text = 'h\na\nb\n'
    const [a, b] = pair(text)
    apply(a, insertRow(parse(text), 1))
    apply(b, setCell(parse(text), 2, 0, 'bee'))
    sync(a, b)
    expect(values(a.getText('content').toString())).toEqual([['h'], [''], ['a'], ['bee']])
  })

  it('merges two people typing in the same cell character by character', () => {
    const text = 'x,hello\n'
    const [a, b] = pair(text)
    apply(a, setCell(parse(text), 0, 1, 'hello world'))
    apply(b, setCell(parse(text), 0, 1, 'oh hello'))
    sync(a, b)
    expect(values(a.getText('content').toString())).toEqual([['x', 'oh hello world']])
  })
})
