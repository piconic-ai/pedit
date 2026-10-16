package canvas

import (
	"bytes"
	"encoding/json"
	"math"
	"slices"
	"sort"
	"strings"
)

// layout is how a file spreads its JSON over lines.
type layout struct {
	// indent is "" for Obsidian's layout: tabs, and each node or edge on one
	// line. Otherwise every value is on its own lines, indented by this, as
	// JSON.stringify(canvas, null, indent) writes.
	indent string
	// newline is whether the file ends with a line break.
	newline bool
}

// obsidian is the layout Obsidian writes, and the one new files get.
var obsidian = layout{}

// The order Obsidian writes fields in, which new fields are written in.
var (
	nodeKeys = []string{"id", "type", "text", "file", "subpath", "url", "x", "y", "width", "height", "color", "label", "background", "backgroundStyle"}
	edgeKeys = []string{"id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"}
)

// detectLayout finds the layout that writes the file back as it was, or
// Obsidian's when none does: then the first write reformats the file once.
func detectLayout(f *File) layout {
	newline := strings.HasSuffix(f.text, "\n")
	candidates := []layout{{"", newline}, {"  ", newline}, {"    ", newline}, {"\t", newline}}
	for _, l := range candidates {
		if string(render(f.Canvas, f, l)) == f.text {
			return l
		}
	}
	return layout{newline: newline}
}

// Render writes a canvas as the file prev was read from would have it: in
// its layout, its items and fields in their order, and unchanged values as
// they were written. With a nil prev it writes a new file in Obsidian's layout.
func Render(c Canvas, prev *File) []byte {
	if prev == nil {
		return render(c, nil, obsidian)
	}
	return render(c, prev, prev.layout)
}

type writer struct {
	bytes.Buffer
	l layout
}

// pad is the indentation at a depth.
func (w *writer) pad(depth int) string {
	if w.l.indent == "" {
		return strings.Repeat("\t", depth)
	}
	return strings.Repeat(w.l.indent, depth)
}

// colon separates a key from its value.
func (w *writer) colon() string {
	if w.l.indent == "" {
		return ":"
	}
	return ": "
}

func render(c Canvas, prev *File, l layout) []byte {
	w := &writer{l: l}
	var keys []string
	has := func(k string) bool { return slices.Contains(keys, k) }
	if prev != nil {
		for _, k := range prev.keys {
			if k == "nodes" || k == "edges" {
				keys = append(keys, k)
			} else if _, ok := c.Extra[k]; ok {
				keys = append(keys, k)
			}
		}
	}
	// A new file, or one with neither list, gets both, as Obsidian writes them.
	bare := prev == nil || (!slices.Contains(prev.keys, "nodes") && !slices.Contains(prev.keys, "edges"))
	for _, k := range []string{"nodes", "edges"} {
		if !has(k) && (bare || len(listOf(c, k)) > 0) {
			keys = append(keys, k)
		}
	}
	keys = append(keys, sortedNew(c.Extra, has)...)

	w.WriteString("{")
	for i, k := range keys {
		if i > 0 {
			w.WriteString(",")
		}
		w.WriteString("\n" + w.pad(1) + quote(k) + w.colon())
		switch k {
		case "nodes", "edges":
			var old []item
			if prev != nil {
				old = prev.items(k)
			}
			w.list(listOf(c, k), old, k)
		default:
			var raw string
			var was any
			if prev != nil {
				raw, was = prev.extra[k], prev.Canvas.Extra[k]
			}
			w.value(c.Extra[k], raw, was, raw != "", 1)
		}
	}
	if len(keys) > 0 {
		w.WriteString("\n")
	}
	w.WriteString("}")
	if l.newline {
		w.WriteString("\n")
	}
	return w.Bytes()
}

func listOf(c Canvas, key string) []map[string]any {
	if key == "nodes" {
		return c.Nodes
	}
	return c.Edges
}

func (f *File) items(key string) []item {
	if key == "nodes" {
		return f.nodes
	}
	return f.edges
}

// sortedNew returns the keys of m not already written, sorted.
func sortedNew(m map[string]any, has func(string) bool) []string {
	var out []string
	for k := range m {
		if !has(k) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func (w *writer) list(items []map[string]any, old []item, key string) {
	if len(items) == 0 {
		w.WriteString("[]")
		return
	}
	byID := make(map[string]*item, len(old))
	for i := range old {
		byID[old[i].id] = &old[i]
	}
	order := nodeKeys
	if key == "edges" {
		order = edgeKeys
	}
	w.WriteString("[")
	for i, it := range items {
		if i > 0 {
			w.WriteString(",")
		}
		w.WriteString("\n" + w.pad(2))
		id, _ := it["id"].(string)
		w.item(it, byID[id], order)
	}
	w.WriteString("\n" + w.pad(1) + "]")
}

// item writes a node or edge. An unchanged one is written exactly as it was.
func (w *writer) item(values map[string]any, old *item, order []string) {
	if old != nil && equal(values, old.values) {
		w.WriteString(old.raw)
		return
	}
	var keys []string
	has := func(k string) bool { return slices.Contains(keys, k) }
	if old != nil {
		for _, k := range old.keys {
			if _, ok := values[k]; ok {
				keys = append(keys, k)
			}
		}
	}
	for _, k := range order {
		if _, ok := values[k]; ok && !has(k) {
			keys = append(keys, k)
		}
	}
	keys = append(keys, sortedNew(values, has)...)

	w.WriteString("{")
	for i, k := range keys {
		if i > 0 {
			w.WriteString(",")
		}
		if w.l.indent != "" {
			w.WriteString("\n" + w.pad(3))
		}
		w.WriteString(quote(k) + w.colon())
		var raw string
		var was any
		var ok bool
		if old != nil {
			raw, ok = old.raws[k]
			was = old.values[k]
		}
		w.value(values[k], raw, was, ok, 3)
	}
	if w.l.indent != "" && len(keys) > 0 {
		w.WriteString("\n" + w.pad(2))
	}
	w.WriteString("}")
}

// value writes v, as it was written before when it has not changed.
func (w *writer) value(v any, raw string, was any, hadRaw bool, depth int) {
	if hadRaw && equal(v, was) {
		w.WriteString(raw)
		return
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if w.l.indent != "" {
		enc.SetIndent(w.pad(depth), w.l.indent)
	}
	if err := enc.Encode(v); err != nil {
		// Decoded JSON and what plain returns always encode. Should
		// anything else get here, the file holds null rather than the host
		// stopping the room for everyone.
		w.WriteString("null")
		return
	}
	w.Write(bytes.TrimRight(b.Bytes(), "\n"))
}

func quote(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimRight(b.String(), "\n")
}

// equal compares decoded JSON values, numbers by value whatever their type.
func equal(a, b any) bool {
	if x, ok := number(a); ok {
		y, ok := number(b)
		return ok && x == y
	}
	switch a := a.(type) {
	case map[string]any:
		b, ok := b.(map[string]any)
		if !ok || len(a) != len(b) {
			return false
		}
		for k, av := range a {
			bv, ok := b[k]
			if !ok || !equal(av, bv) {
				return false
			}
		}
		return true
	case []any:
		b, ok := b.([]any)
		if !ok || len(a) != len(b) {
			return false
		}
		for i := range a {
			if !equal(a[i], b[i]) {
				return false
			}
		}
		return true
	}
	return a == b
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case int64:
		return float64(n), true
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	}
	return 0, false
}
