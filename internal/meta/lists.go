package meta

import (
	"fmt"
	"sort"
)

// The items of a map under one key form a list. Yjs and ygo integrate an
// item by walking its list from its origin, past items inserted after the
// same or a later origin, so a list costs time up to the square of its
// length to apply: an update can make a list long with one long chain of
// origins, or many items after the same one, and a peer that joins applies
// every list at once. lists finds the list of each item of
// the doc and an update, by its parent and key or by the item it follows,
// as Yjs would, and tells which items it cannot place: those would wait
// for structs not received yet.
type lists struct {
	recs []record
	doc  int // the first records are the doc's; the rest, the update's
	// Each client's records, by clock.
	byClient map[uint64][]int
	state    []byte // unseen, seen or done, as list works through them
	list     []string
	placed   []bool
}

const (
	unseen = iota
	seen
	done
)

// newLists takes the records of the doc and the new ones of an update.
func newLists(doc, fresh []record) *lists {
	l := &lists{recs: append(append([]record{}, doc...), fresh...), doc: len(doc), byClient: map[uint64][]int{}}
	for i, r := range l.recs {
		l.byClient[r.at.client] = append(l.byClient[r.at.client], i)
	}
	for _, is := range l.byClient {
		sort.Slice(is, func(a, b int) bool { return l.recs[is[a]].at.clock < l.recs[is[b]].at.clock })
	}
	l.state = make([]byte, len(l.recs))
	l.list = make([]string, len(l.recs))
	l.placed = make([]bool, len(l.recs))
	return l
}

// find is the record holding x, or -1.
func (l *lists) find(x id) int {
	is := l.byClient[x.client]
	k := sort.Search(len(is), func(k int) bool {
		r := l.recs[is[k]]
		return r.at.clock+r.length > x.clock
	})
	if k == len(is) || l.recs[is[k]].at.clock > x.clock {
		return -1
	}
	return is[k]
}

// step is where record i's list comes from: the record j it depends on
// (-1 for none), which must be placed for it to be, and its own list, or ""
// to take j's. Without j, ok tells whether it can be placed at all.
func (l *lists) step(i int) (j int, list string, ok bool) {
	r := l.recs[i]
	if !r.item {
		return -1, "", true // garbage: in no list
	}
	dep := r.parent
	if r.origin != nil {
		dep = r.origin
	}
	if dep == nil {
		return -1, "r " + r.root + "\x00" + r.key, true
	}
	// A client's structs come in order: one cannot follow its own later one.
	if dep.client == r.at.client && dep.clock >= r.at.clock {
		return -1, "", false
	}
	if j = l.find(*dep); j < 0 {
		return -1, "", false
	}
	if r.origin == nil {
		list = fmt.Sprintf("p %d %d\x00%s", dep.client, dep.clock, r.key)
	}
	return j, list, true
}

// resolve finds the list of every record, and whether it can be placed,
// without recursion: a chain of origins can be as long as the doc.
func (l *lists) resolve() {
	for i := range l.recs {
		stack := []int{i}
		for len(stack) > 0 {
			k := stack[len(stack)-1]
			if l.state[k] == done {
				stack = stack[:len(stack)-1]
				continue
			}
			j, list, ok := l.step(k)
			switch {
			case j < 0:
				l.finish(k, list, ok)
			case l.state[j] == done:
				if list == "" {
					list = l.list[j]
				}
				l.finish(k, list, l.placed[j])
			case l.state[j] == seen:
				l.finish(k, "", false) // a cycle of origins or parents
			default:
				l.state[k] = seen
				stack = append(stack, j)
				continue
			}
			stack = stack[:len(stack)-1]
		}
	}
}

func (l *lists) finish(k int, list string, ok bool) {
	l.state[k], l.list[k], l.placed[k] = done, list, ok
}

// check tells whether an update's records can all be placed, and whether
// applying the doc's lists, with them, could take more than MaxListWork.
func (l *lists) check() (missing, long bool) {
	l.resolve()
	lengths := map[string]int{}
	for i := range l.recs {
		if i >= l.doc && !l.placed[i] {
			missing = true
		}
		if r := l.recs[i]; l.placed[i] && l.list[i] != "" {
			// A run of values splits, copying the rest of it, each time an
			// item goes inside it: it weighs as many items. Deleted runs,
			// as a peer keeps many, split for free.
			if r.values {
				lengths[l.list[i]] += int(r.length)
			} else {
				lengths[l.list[i]]++
			}
		}
	}
	work := 0
	for _, n := range lengths {
		work += n * n
	}
	return missing, work > MaxListWork
}

// splits counts the ends of a deleted range [clock, clock+length) of client
// that fall inside a struct, which deleting it splits in two.
func (l *lists) splits(client, clock, length uint64) int {
	n := 0
	for _, x := range [2]uint64{clock, clock + length} {
		if i := l.find(id{client, x}); i >= 0 && l.recs[i].at.clock != x {
			n++
		}
	}
	return n
}
