package canvas

import (
	"sort"

	"github.com/piconic-ai/pedit/internal/merge"
	"github.com/reearth/ygo/crdt"
)

// Apply makes in a document the change from base to next: an edit made to the
// file outside pedit, or JSON someone edited by hand in the browser. The
// document may have moved on from base meanwhile, and what others changed
// there is kept unless the change touches the same field. Nodes and edges are
// matched by id; a text node's text merges by character.
//
// The caller must keep the document from changing concurrently, and must not
// call Apply from inside a transaction.
func Apply(doc *crdt.Doc, base, next Canvas, origin any) {
	var texts []textEdit
	texts = append(texts, applyList(doc, doc.GetArray(NodesKey), base.Nodes, next.Nodes, origin)...)
	texts = append(texts, applyList(doc, doc.GetArray(EdgesKey), base.Edges, next.Edges, origin)...)

	extra := doc.GetMap(ExtraKey)
	if keys := changedKeys(base.Extra, next.Extra); len(keys) > 0 {
		doc.Transact(func(txn *crdt.Transaction) {
			for _, k := range keys {
				if v, ok := next.Extra[k]; ok {
					extra.Set(txn, k, v)
				} else {
					extra.Delete(txn, k)
				}
			}
		}, origin)
	}

	for _, t := range texts {
		merge.ExternalEdit(doc, t.text, t.base, t.next, origin)
	}
}

// textEdit is a change to a text node's text, merged by character once the
// structure is in place.
type textEdit struct {
	text       *crdt.YText
	base, next string
}

// changedKeys returns the keys whose value differs between a and b, sorted.
func changedKeys(a, b map[string]any) []string {
	var keys []string
	for k, v := range a {
		if w, ok := b[k]; !ok || !equal(v, w) {
			keys = append(keys, k)
		}
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	return keys
}

func idOf(values map[string]any) string {
	id, _ := values["id"].(string)
	return id
}

// entry is one item of a list in the document.
type entry struct {
	id string
	m  *crdt.YMap
	// Its values, and its text as a Y.Text when it has one.
	now  map[string]any
	text *crdt.YText
}

// readEntries reads a list. Reads take the document lock, which a
// transaction holds, so lists are read before one starts.
func readEntries(list *crdt.YArray) []entry {
	var out []entry
	for i := 0; i < list.Len(); i++ {
		e := entry{}
		if m, ok := list.Get(i).(*crdt.YMap); ok {
			e.m = m
			e.now = map[string]any{}
			for _, k := range m.Keys() {
				v, _ := m.Get(k)
				if t, ok := v.(*crdt.YText); ok && k == TextKey {
					e.text = t
				}
				e.now[k] = plain(v)
			}
			e.id = idOf(e.now)
		}
		out = append(out, e)
	}
	return out
}

func indexOf(entries []entry, id string) int {
	for i, e := range entries {
		if e.id == id && id != "" {
			return i
		}
	}
	return -1
}

// listChange is the change applyList makes to one list. It reads the list
// before the transaction starts, and keeps the list's items as they stand
// while the transaction changes them.
type listChange struct {
	list               *crdt.YArray
	next               []map[string]any
	baseByID, nextByID map[string]map[string]any
	nowByID            map[string]entry
	moved              map[string]bool
	current            []entry
	// Text edits, made once the transaction ends.
	texts []textEdit
}

func applyList(doc *crdt.Doc, list *crdt.YArray, base, next []map[string]any, origin any) []textEdit {
	c := newListChange(list, base, next)
	doc.Transact(func(txn *crdt.Transaction) {
		c.remove(txn)
		c.insert(txn)
		c.update(txn)
	}, origin)
	return c.texts
}

func newListChange(list *crdt.YArray, base, next []map[string]any) *listChange {
	c := &listChange{
		list:     list,
		next:     next,
		baseByID: byID(base),
		nextByID: byID(next),
		nowByID:  map[string]entry{},
		current:  readEntries(list),
		moved:    movedIDs(base, next),
	}
	for _, e := range c.current {
		if _, dup := c.nowByID[e.id]; !dup && e.id != "" {
			c.nowByID[e.id] = e
		}
	}
	return c
}

func byID(items []map[string]any) map[string]map[string]any {
	out := map[string]map[string]any{}
	for _, v := range items {
		out[idOf(v)] = v
	}
	return out
}

// merge queues a text edit: one on a field set in the same transaction waits
// for it to end.
func (c *listChange) merge(t *crdt.YText, b, n string) {
	if b != n {
		c.texts = append(c.texts, textEdit{t, b, n})
	}
}

// remove takes out what next removed, and what it moved, which goes back in
// its new place.
func (c *listChange) remove(txn *crdt.Transaction) {
	for i := len(c.current) - 1; i >= 0; i-- {
		id := c.current[i].id
		_, inBase := c.baseByID[id]
		_, inNext := c.nextByID[id]
		if id != "" && ((inBase && !inNext) || c.moved[id]) {
			c.list.Delete(txn, i, 1)
			c.current = append(c.current[:i], c.current[i+1:]...)
		}
	}
}

// insert puts back what next added or moved.
func (c *listChange) insert(txn *crdt.Transaction) {
	for i, v := range c.next {
		if indexOf(c.current, idOf(v)) < 0 {
			c.insertItem(txn, i, v)
		}
	}
}

// insertItem puts in v, the i-th item of next.
func (c *listChange) insertItem(txn *crdt.Transaction, i int, v map[string]any) {
	id := idOf(v)
	b, inBase := c.baseByID[id]
	values := v
	mergeText := false
	if inBase {
		now, inDoc := c.nowByID[id]
		if !inDoc {
			// Someone else deleted it meanwhile: that deletion stands.
			return
		}
		// A moved item keeps what others changed meanwhile, with next's changes on top.
		values, mergeText = overlay(now.now, b, v)
	}
	at := c.insertAt(i)
	m, text := newItem(txn, values)
	c.list.InsertType(txn, at, m)
	c.current = append(c.current[:at], append([]entry{{id: id, m: m}}, c.current[at:]...)...)
	if mergeText && text != nil {
		bs, _ := b[TextKey].(string)
		ns, _ := v[TextKey].(string)
		c.merge(text, bs, ns)
	}
}

// insertAt returns where the i-th item of next goes: before the item after it
// in next, or on top, so a node brought to the front stays in front of what
// others added meanwhile.
func (c *listChange) insertAt(i int) int {
	for _, after := range c.next[i+1:] {
		if k := indexOf(c.current, idOf(after)); k >= 0 {
			return k
		}
	}
	return len(c.current)
}

// update changes the fields next changed, in the items that stayed where
// they were.
func (c *listChange) update(txn *crdt.Transaction) {
	for _, e := range c.current {
		b, inBase := c.baseByID[e.id]
		n, inNext := c.nextByID[e.id]
		now, inDoc := c.nowByID[e.id]
		if !inBase || !inNext || !inDoc || c.moved[e.id] || now.m != e.m {
			continue
		}
		for _, k := range changedKeys(b, n) {
			c.updateField(txn, e.m, now.text, k, b, n)
		}
	}
}

// updateField makes in m the change from b to n of the field k. text is m's
// text as a Y.Text, if it has one.
func (c *listChange) updateField(txn *crdt.Transaction, m *crdt.YMap, text *crdt.YText, k string, b, n map[string]any) {
	nv, keep := n[k]
	if !keep {
		m.Delete(txn, k)
		return
	}
	ns, isString := nv.(string)
	if k != TextKey || !isString {
		m.Set(txn, k, nv)
		return
	}
	if bs, wasString := b[k].(string); wasString && text != nil {
		c.merge(text, bs, ns)
		return
	}
	t := crdt.NewTextPrelim()
	t.Insert(txn, 0, ns, nil)
	m.Set(txn, k, t)
}

// overlay returns now with the change from base to next on top. A text that
// next changes and now still has is left as it is now, and mergeText says it
// is to merge by character afterwards; a text only next has is taken as it
// is, and one next removed is removed.
func overlay(now, base, next map[string]any) (out map[string]any, mergeText bool) {
	out = make(map[string]any, len(now))
	for k, v := range now {
		out[k] = v
	}
	for _, k := range changedKeys(base, next) {
		_, inNow := out[k]
		_, inNext := next[k]
		if k == TextKey && inNow && inNext {
			mergeText = true
			continue
		}
		if v, ok := next[k]; ok {
			out[k] = v
		} else {
			delete(out, k)
		}
	}
	return out, mergeText
}

// movedIDs returns the items next put in a different order than base. Those
// in a longest run kept in order stay where they are; the rest move, so a
// node brought to the front moves alone.
func movedIDs(base, next []map[string]any) map[string]bool {
	baseIndex := map[string]int{}
	for i, v := range base {
		baseIndex[idOf(v)] = i
	}
	var ids []string
	var seq []int
	for _, v := range next {
		if i, ok := baseIndex[idOf(v)]; ok {
			ids = append(ids, idOf(v))
			seq = append(seq, i)
		}
	}
	keep := longestIncreasing(seq)
	moved := map[string]bool{}
	for i, id := range ids {
		if !keep[i] {
			moved[id] = true
		}
	}
	return moved
}

// longestIncreasing marks the positions of a longest increasing subsequence.
func longestIncreasing(seq []int) map[int]bool {
	// tails[k] is the index in seq ending the best run of length k+1.
	var tails []int
	prev := make([]int, len(seq))
	for i, v := range seq {
		k := sort.Search(len(tails), func(k int) bool { return seq[tails[k]] >= v })
		prev[i] = -1
		if k > 0 {
			prev[i] = tails[k-1]
		}
		if k == len(tails) {
			tails = append(tails, i)
		} else {
			tails[k] = i
		}
	}
	keep := map[int]bool{}
	if len(tails) > 0 {
		for i := tails[len(tails)-1]; i >= 0; i = prev[i] {
			keep[i] = true
		}
	}
	return keep
}
