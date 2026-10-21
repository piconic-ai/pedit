// Package canvas reads and writes JSON Canvas files (https://jsoncanvas.org)
// and moves them in and out of a shared document. The host shares a canvas as
// structure, not text: nodes and edges are Y.Maps in Y.Arrays, so co-editing
// on the canvas cannot produce invalid JSON. The file stays the source of
// truth: it is written back in its own layout, and a file read and written
// back unchanged is byte-identical. The exceptions are a file with neither
// list, such as {} or an empty file, which gets both as Obsidian writes them,
// and a file in a layout this package does not know, which is rewritten once
// in Obsidian's.
package canvas

import (
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

// Canvas is the content of a canvas: its nodes and edges in file order, and
// any other top-level keys. Values are decoded JSON: nil, bool, string, int64,
// float64, []any or map[string]any.
type Canvas struct {
	Nodes []map[string]any
	Edges []map[string]any
	Extra map[string]any
}

// File is a canvas as it was read, with what it takes to write it back the
// way it was: the text of every item and field, and the file's layout.
type File struct {
	Canvas Canvas
	text   string
	layout layout
	// Top-level keys in file order.
	keys  []string
	nodes []item
	edges []item
	extra map[string]string
}

// item is one node or edge as it appeared in the file.
type item struct {
	id     string
	raw    string
	keys   []string
	raws   map[string]string
	values map[string]any
}

// Text returns the file's text as it was read.
func (f *File) Text() string { return f.text }

// jnode is a JSON value with where it sits in the text.
type jnode struct {
	start, end int
	value      any // for scalars: nil, bool, string or json.Number
	kind       byte
	fields     []jfield // objects
	items      []*jnode // arrays
}

type jfield struct {
	key      string
	keyStart int
	val      *jnode
}

const (
	kindObject = 'o'
	kindArray  = 'a'
	kindScalar = 's'
)

type parser struct {
	data string
	dec  *json.Decoder
}

// next returns where the next token starts: after the whitespace, commas and
// colons the decoder consumes silently.
func (p *parser) next() int {
	i := int(p.dec.InputOffset())
	for i < len(p.data) && strings.IndexByte(" \t\r\n,:", p.data[i]) >= 0 {
		i++
	}
	return i
}

func (p *parser) value() (*jnode, error) {
	start := p.next()
	tok, err := p.dec.Token()
	if err != nil {
		return nil, err
	}
	n := &jnode{start: start}
	if d, ok := tok.(json.Delim); ok {
		if err := p.container(n, d); err != nil {
			return nil, err
		}
	} else {
		n.kind = kindScalar
		n.value = tok
	}
	n.end = int(p.dec.InputOffset())
	return n, nil
}

// container reads an object or array after its opening delimiter, up to and
// including the closing one.
func (p *parser) container(n *jnode, open json.Delim) error {
	var err error
	switch open {
	case '{':
		n.kind = kindObject
		err = p.fields(n)
	case '[':
		n.kind = kindArray
		err = p.items(n)
	}
	if err != nil {
		return err
	}
	_, err = p.dec.Token()
	return err
}

func (p *parser) fields(n *jnode) error {
	for p.dec.More() {
		keyStart := p.next()
		k, err := p.dec.Token()
		if err != nil {
			return err
		}
		key, _ := k.(string)
		v, err := p.value()
		if err != nil {
			return err
		}
		n.fields = append(n.fields, jfield{key: key, keyStart: keyStart, val: v})
	}
	return nil
}

func (p *parser) items(n *jnode) error {
	for p.dec.More() {
		v, err := p.value()
		if err != nil {
			return err
		}
		n.items = append(n.items, v)
	}
	return nil
}

func (n *jnode) raw(data string) string { return data[n.start:n.end] }

// decode turns a jnode into a plain value, as the document stores it.
func (n *jnode) decode() any {
	switch n.kind {
	case kindObject:
		m := make(map[string]any, len(n.fields))
		for _, f := range n.fields {
			m[f.key] = f.val.decode()
		}
		return m
	case kindArray:
		s := make([]any, len(n.items))
		for i, it := range n.items {
			s[i] = it.decode()
		}
		return s
	}
	if num, ok := n.value.(json.Number); ok {
		return decodeNumber(num)
	}
	return n.value
}

// decodeNumber keeps whole numbers whole, as Obsidian writes positions.
func decodeNumber(num json.Number) any {
	if !strings.ContainsAny(string(num), ".eE") {
		if i, err := num.Int64(); err == nil {
			return i
		}
	}
	f, _ := num.Float64()
	return f
}

// Parse reads a JSON Canvas file. An empty file is an empty canvas, as a new
// .canvas is. Anything that is not valid JSON Canvas returns an *Error listing
// every problem found, with where it is.
func Parse(data []byte) (*File, error) {
	text := string(data)
	if !utf8.ValidString(text) {
		return nil, &Error{Problems: []Problem{{Line: 1, Column: 1, Message: "the file is not UTF-8 text"}}}
	}
	if strings.TrimSpace(text) == "" {
		return &File{text: text, layout: obsidian, Canvas: Canvas{Extra: map[string]any{}}}, nil
	}
	// The plain decoder reports syntax errors where they are; the token
	// stream below reports some one token early.
	var probe any
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, &Error{Problems: []Problem{syntaxProblem(text, err)}}
	}
	p := &parser{data: text, dec: json.NewDecoder(strings.NewReader(text))}
	p.dec.UseNumber()
	root, err := p.value()
	if err != nil {
		// Unmarshal accepted the text, so the decoder cannot fail on it.
		return nil, err
	}
	v := &validator{text: text}
	f := v.file(root)
	if len(v.problems) > 0 {
		return nil, &Error{Problems: v.problems, More: v.more}
	}
	f.text = text
	f.layout = detectLayout(f)
	return f, nil
}

func syntaxProblem(text string, err error) Problem {
	var syntax *json.SyntaxError
	offset := len(text)
	message := err.Error()
	switch {
	case strings.Contains(message, "unexpected end of JSON input"):
		message = "the JSON ends too early: a bracket, brace or quote is not closed"
	case errors.As(err, &syntax):
		// The decoder reports the offset after the offending byte.
		offset = max(int(syntax.Offset)-1, 0)
	}
	line, col := position(text, offset)
	msg := "invalid JSON: " + message
	if hint := syntaxHint(text, offset, message); hint != "" {
		msg += " (" + hint + ")"
	}
	return Problem{Line: line, Column: col, Message: msg}
}

// syntaxHint names the usual cause of a syntax error at offset, when there
// is one. message is the decoder's, which says what it expected there.
func syntaxHint(text string, offset int, message string) string {
	if offset >= len(text) {
		return ""
	}
	c := text[offset]
	switch {
	// A comment can follow anything, so it is named before what the decoder expected.
	case c == '/' || c == '#':
		return "JSON does not allow comments"
	case strings.Contains(message, "after object key:value pair"), strings.Contains(message, "after array element"):
		return "a comma is probably missing before this"
	case strings.Contains(message, "after object key"):
		return "a colon is probably missing after the key"
	case c == '}' || c == ']':
		if strings.HasSuffix(strings.TrimRight(text[:offset], " \t\r\n"), ",") {
			return "JSON does not allow a comma before a closing bracket"
		}
	case c == '\'':
		return "JSON strings use double quotes"
	}
	return ""
}

// position turns a byte offset into a 1-based line and column (in characters).
func position(text string, offset int) (line, col int) {
	offset = min(offset, len(text))
	before := text[:offset]
	line = strings.Count(before, "\n") + 1
	lineStart := strings.LastIndexByte(before, '\n') + 1
	return line, utf8.RuneCountInString(before[lineStart:]) + 1
}
