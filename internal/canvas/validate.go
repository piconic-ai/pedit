package canvas

import (
	"fmt"
	"slices"
	"strings"
)

// Spec is where the format is described, for people and agents fixing a file.
const Spec = "https://jsoncanvas.org/spec/1.0/"

// maxProblems caps how many problems an Error lists.
const maxProblems = 20

// Problem is one thing wrong with a canvas file.
type Problem struct {
	// 1-based line and column (in characters) of what is wrong.
	Line, Column int
	// Where in the canvas, as a JSON path such as nodes[3].width; empty for the file as a whole.
	Path    string
	Message string
}

// Error lists what makes a file not valid JSON Canvas.
type Error struct {
	Problems []Problem
	// How many problems were found beyond those listed.
	More int
}

func (e *Error) Error() string { return e.Report("") }

// Lines lists the problems for someone, or a coding agent, to fix the file:
// one "file:line:column: path: message" line each, which editors and agents
// can jump to, and a last line counting those not listed, if any.
func (e *Error) Lines(name string) []string {
	if name == "" {
		name = "the file"
	}
	var lines []string
	for _, p := range e.Problems {
		line := fmt.Sprintf("%s:%d:%d: ", name, p.Line, p.Column)
		if p.Path != "" {
			line += p.Path + ": "
		}
		lines = append(lines, line+p.Message)
	}
	if e.More > 0 {
		lines = append(lines, fmt.Sprintf("and %d more", e.More))
	}
	return lines
}

// Report explains the problems for someone, or a coding agent, to fix the
// file: Lines, then what to do.
func (e *Error) Report(name string) string {
	if name == "" {
		name = "the file"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s is not a valid JSON Canvas (%s):\n", name, Spec)
	for _, line := range e.Lines(name) {
		b.WriteString("  " + line + "\n")
	}
	b.WriteString("Fix the file and run pedit again.")
	return b.String()
}

var (
	nodeTypes        = []string{"text", "file", "link", "group"}
	sides            = []string{"top", "right", "bottom", "left"}
	ends             = []string{"none", "arrow"}
	backgroundStyles = []string{"cover", "ratio", "repeat"}
)

type validator struct {
	text     string
	problems []Problem
	more     int
}

func (v *validator) report(offset int, path, format string, args ...any) {
	if len(v.problems) >= maxProblems {
		v.more++
		return
	}
	line, col := position(v.text, offset)
	v.problems = append(v.problems, Problem{Line: line, Column: col, Path: path, Message: fmt.Sprintf(format, args...)})
}

// describe names a JSON value's type for messages.
func describe(n *jnode) string { return typeName(n.decode()) }

// object checks n is an object with each key once, and returns its fields by key.
func (v *validator) object(n *jnode, path string) (map[string]jfield, bool) {
	if n.kind != kindObject {
		v.report(n.start, path, "must be an object, not %s", describe(n))
		return nil, false
	}
	fields := make(map[string]jfield, len(n.fields))
	for _, f := range n.fields {
		if _, dup := fields[f.key]; dup {
			v.report(f.keyStart, path, "%q appears more than once; keep one", f.key)
		}
		fields[f.key] = f
	}
	return fields, true
}

func (v *validator) file(root *jnode) *File {
	fields, ok := v.object(root, "")
	if !ok {
		return nil
	}
	f := &File{extra: map[string]string{}, Canvas: Canvas{Extra: map[string]any{}}}
	for _, fl := range root.fields {
		f.keys = append(f.keys, fl.key)
		if fl.key != "nodes" && fl.key != "edges" {
			f.extra[fl.key] = fl.val.raw(v.text)
			f.Canvas.Extra[fl.key] = fl.val.decode()
		}
	}
	nodeIDs := map[string]bool{}
	f.nodes = v.list(fields, "nodes", func(n *jnode, path string) (item, bool) {
		return v.node(n, path, nodeIDs)
	})
	edgeIDs := map[string]bool{}
	f.edges = v.list(fields, "edges", func(n *jnode, path string) (item, bool) {
		return v.edge(n, path, edgeIDs, nodeIDs)
	})
	for _, it := range f.nodes {
		f.Canvas.Nodes = append(f.Canvas.Nodes, it.values)
	}
	for _, it := range f.edges {
		f.Canvas.Edges = append(f.Canvas.Edges, it.values)
	}
	return f
}

func (v *validator) list(fields map[string]jfield, key string, check func(*jnode, string) (item, bool)) []item {
	fl, ok := fields[key]
	if !ok {
		return nil
	}
	if fl.val.kind != kindArray {
		v.report(fl.val.start, key, "must be a list, not %s", describe(fl.val))
		return nil
	}
	var items []item
	for i, n := range fl.val.items {
		if it, ok := check(n, fmt.Sprintf("%s[%d]", key, i)); ok {
			items = append(items, it)
		}
	}
	return items
}

// item reads a node's or edge's fields in order, with their text.
func (v *validator) item(n *jnode) item {
	it := item{raw: n.raw(v.text), raws: map[string]string{}, values: map[string]any{}}
	for _, f := range n.fields {
		if _, seen := it.raws[f.key]; !seen {
			it.keys = append(it.keys, f.key)
		}
		it.raws[f.key] = f.val.raw(v.text)
		it.values[f.key] = f.val.decode()
	}
	return it
}

// itemPath names an item for messages, with its id when it has one.
func itemPath(path string, n *jnode) string {
	for _, f := range n.fields {
		if s, ok := f.val.value.(string); ok && f.key == "id" && s != "" {
			return fmt.Sprintf("%s (id %q)", path, s)
		}
	}
	return path
}

// issue is one rule a node or edge breaks. key is the field it is about,
// which Parse points at when the field is there, or "" for the item.
type issue struct {
	key, msg string
}

// typeName names a decoded value's type for messages.
func typeName(v any) string {
	switch v.(type) {
	case map[string]any:
		return "an object"
	case []any:
		return "a list"
	case string:
		return "a string"
	case bool:
		return "true or false"
	case nil:
		return "null"
	}
	return "a number"
}

// checkID checks the required, unique id, and marks it seen.
func checkID(values map[string]any, seen map[string]bool) (string, []issue) {
	v, ok := values["id"]
	if !ok {
		return "", []issue{{"", `has no "id"; add a unique string id`}}
	}
	id, ok := v.(string)
	if !ok || id == "" {
		return "", []issue{{"id", fmt.Sprintf(`"id" must be a non-empty string, not %s`, typeName(v))}}
	}
	if seen[id] {
		return "", []issue{{"id", fmt.Sprintf("id %q is used more than once; ids must be unique", id)}}
	}
	seen[id] = true
	return id, nil
}

// checkString checks an optional (or, with required, a required) string
// field, limited to allowed when it is not nil.
func checkString(values map[string]any, key string, required bool, allowed []string) (string, []issue) {
	v, ok := values[key]
	if !ok {
		if required {
			return "", []issue{{"", fmt.Sprintf("has no %q; add it as a string", key)}}
		}
		return "", nil
	}
	s, ok := v.(string)
	if !ok {
		return "", []issue{{key, fmt.Sprintf("%q must be a string, not %s", key, typeName(v))}}
	}
	if allowed != nil && !slices.Contains(allowed, s) {
		return "", []issue{{key, fmt.Sprintf("%q is %q; it must be one of %s", key, s, quoteAll(allowed))}}
	}
	return s, nil
}

func quoteAll(values []string) string {
	q := make([]string, len(values))
	for i, s := range values {
		q[i] = fmt.Sprintf("%q", s)
	}
	return strings.Join(q, ", ")
}

// checkNode returns what is wrong with a node, the same rules for a file
// (Parse) and a document (Read). ids collects the node ids seen.
func checkNode(values map[string]any, ids map[string]bool) []issue {
	_, issues := checkID(values, ids)
	typ, more := checkString(values, "type", true, nil)
	issues = append(issues, more...)
	for _, key := range []string{"x", "y", "width", "height"} {
		v, ok := values[key]
		if !ok {
			issues = append(issues, issue{"", fmt.Sprintf("has no %q; add it as a number", key)})
		} else if _, ok := number(v); !ok {
			issues = append(issues, issue{key, fmt.Sprintf("%q must be a number, not %s", key, typeName(v))})
		}
	}
	add := func(key string, required bool, allowed []string) {
		_, more := checkString(values, key, required, allowed)
		issues = append(issues, more...)
	}
	// Types the spec does not define are kept and drawn as a plain box.
	switch typ {
	case "text":
		add("text", true, nil)
	case "file":
		add("file", true, nil)
		add("subpath", false, nil)
	case "link":
		add("url", true, nil)
	case "group":
		add("label", false, nil)
		add("background", false, nil)
		add("backgroundStyle", false, backgroundStyles)
	}
	add("color", false, nil)
	return issues
}

// checkEdge returns what is wrong with an edge. ids collects the edge ids
// seen; nodes are the ids of the nodes it may join.
func checkEdge(values map[string]any, ids, nodes map[string]bool) []issue {
	_, issues := checkID(values, ids)
	for _, key := range []string{"fromNode", "toNode"} {
		s, more := checkString(values, key, true, nil)
		issues = append(issues, more...)
		if more == nil && !nodes[s] {
			issues = append(issues, issue{key, fmt.Sprintf("%q is %q, which is not the id of any node", key, s)})
		}
	}
	for _, f := range []struct {
		key     string
		allowed []string
	}{{"fromSide", sides}, {"toSide", sides}, {"fromEnd", ends}, {"toEnd", ends}, {"color", nil}, {"label", nil}} {
		_, more := checkString(values, f.key, false, f.allowed)
		issues = append(issues, more...)
	}
	return issues
}

// checked reports an item's issues where they are in the file, and returns
// the item when it has none.
func (v *validator) checked(n *jnode, path string, check func(map[string]any) []issue) (item, bool) {
	path = itemPath(path, n)
	fields, ok := v.object(n, path)
	if !ok {
		return item{}, false
	}
	it := v.item(n)
	issues := check(it.values)
	for _, is := range issues {
		offset := n.start
		if f, ok := fields[is.key]; ok && is.key != "" {
			offset = f.val.start
		}
		v.report(offset, path, "%s", is.msg)
	}
	if len(issues) > 0 {
		return item{}, false
	}
	it.id, _ = it.values["id"].(string)
	return it, true
}

func (v *validator) node(n *jnode, path string, ids map[string]bool) (item, bool) {
	return v.checked(n, path, func(values map[string]any) []issue { return checkNode(values, ids) })
}

func (v *validator) edge(n *jnode, path string, ids, nodes map[string]bool) (item, bool) {
	return v.checked(n, path, func(values map[string]any) []issue { return checkEdge(values, ids, nodes) })
}
