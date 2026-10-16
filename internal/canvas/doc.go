package canvas

import (
	"encoding/json"
	"math"

	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
)

// The shared types a canvas room keeps its content in. packages/web reads the
// same names: keep them in sync.
const (
	// NodesKey is a Y.Array of Y.Maps, one per node, in file order.
	NodesKey = "nodes"
	// EdgesKey is a Y.Array of Y.Maps, one per edge, in file order.
	EdgesKey = "edges"
	// ExtraKey is a Y.Map of the file's other top-level keys.
	ExtraKey = "extra"
	// TextKey is the one field kept as a Y.Text, so that people typing in
	// the same text node merge by character.
	TextKey = "text"
)

// Load puts a canvas into a document that has none yet.
func Load(doc *crdt.Doc, c Canvas) {
	// Resolve the shared types before the transaction, which holds the lock they take.
	nodes := doc.GetArray(NodesKey)
	edges := doc.GetArray(EdgesKey)
	extra := doc.GetMap(ExtraKey)
	doc.Transact(func(txn *crdt.Transaction) {
		for _, n := range c.Nodes {
			m, _ := newItem(txn, n)
			nodes.PushType(txn, m)
		}
		for _, e := range c.Edges {
			m, _ := newItem(txn, e)
			edges.PushType(txn, m)
		}
		for k, v := range c.Extra {
			extra.Set(txn, k, v)
		}
	})
}

// newItem makes the Y.Map for a node or edge, and returns its text's Y.Text
// when it has one.
func newItem(txn *crdt.Transaction, values map[string]any) (*crdt.YMap, *crdt.YText) {
	m := crdt.NewMapPrelim()
	var text *crdt.YText
	for k, v := range values {
		if s, ok := v.(string); ok && k == TextKey {
			text = crdt.NewTextPrelim()
			text.Insert(txn, 0, s, nil)
			m.Set(txn, k, text)
			continue
		}
		m.Set(txn, k, v)
	}
	return m, text
}

// Read returns the canvas in a document, with values as Parse decodes them.
// Structure keeps the JSON valid but not the canvas: one person can delete a
// node while another joins an edge to it, and a newer or broken peer can
// leave out a field. Read skips what a file could not hold, by the rules
// Parse applies, so what it returns always renders to a file Parse accepts.
// packages/web skips the same, so the page and the file show one canvas.
// Must not be called from inside a transaction.
func Read(doc *crdt.Doc) Canvas {
	c := Canvas{Extra: map[string]any{}}
	nodeIDs, kept := map[string]bool{}, map[string]bool{}
	for _, n := range readItems(doc.GetArray(NodesKey)) {
		if len(checkNode(n, nodeIDs)) == 0 {
			c.Nodes = append(c.Nodes, n)
			kept[n["id"].(string)] = true
		}
	}
	edgeIDs := map[string]bool{}
	for _, e := range readItems(doc.GetArray(EdgesKey)) {
		if len(checkEdge(e, edgeIDs, kept)) == 0 {
			c.Edges = append(c.Edges, e)
		}
	}
	extra := doc.GetMap(ExtraKey)
	for _, k := range extra.Keys() {
		v, _ := extra.Get(k)
		c.Extra[k] = plain(v)
	}
	return c
}

func readItems(a *crdt.YArray) []map[string]any {
	var out []map[string]any
	for i := 0; i < a.Len(); i++ {
		// Anything but a Y.Map is not an item: a newer or broken peer's.
		m, ok := a.Get(i).(*crdt.YMap)
		if !ok {
			continue
		}
		values := map[string]any{}
		for _, k := range m.Keys() {
			v, _ := m.Get(k)
			values[k] = plain(v)
		}
		out = append(out, values)
	}
	return out
}

// plain turns a document value into decoded JSON: shared types into their
// content, and every number type into int64 when whole, float64 otherwise.
// Yjs sends 1.5 as a float32 and whole numbers as integers. Any peer can put
// anything in the document, so what JSON cannot hold becomes nil: NaN and
// infinities, binary, subdocuments and the other shared types. Passing those
// on would make Render fail, and Apply panic on an attached type.
func plain(v any) any {
	switch v := v.(type) {
	case nil, bool, string, int64:
		return v
	case encoding.BigInt:
		return int64(v)
	case *crdt.YText:
		return v.ToString()
	case *crdt.YMap, *crdt.YArray:
		var data []byte
		if m, ok := v.(*crdt.YMap); ok {
			data, _ = m.ToJSON()
		} else {
			data, _ = v.(*crdt.YArray).ToJSON()
		}
		var out any
		if err := json.Unmarshal(data, &out); err != nil {
			return nil
		}
		return plain(out)
	case map[string]any:
		m := make(map[string]any, len(v))
		for k, x := range v {
			m[k] = plain(x)
		}
		return m
	case []any:
		s := make([]any, len(v))
		for i, x := range v {
			s[i] = plain(x)
		}
		return s
	case float32:
		return whole(float64(v))
	case float64:
		return whole(v)
	case int:
		return int64(v)
	case int8:
		return int64(v)
	case int16:
		return int64(v)
	case int32:
		return int64(v)
	case uint8:
		return int64(v)
	case uint16:
		return int64(v)
	case uint32:
		return int64(v)
	case uint64:
		return int64(v)
	}
	return nil
}

// whole makes a float that holds a whole number an int64, as Parse would read
// it, and one that JSON cannot hold nil.
func whole(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	if f == float64(int64(f)) && f >= -1<<53 && f <= 1<<53 {
		return int64(f)
	}
	return f
}
