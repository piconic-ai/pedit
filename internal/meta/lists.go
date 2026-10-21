package meta

import (
	"fmt"
	"sort"
)

// The items of a map under one key form a list. Yjs and ygo integrate an
// item by walking its list from its origin, past items inserted after the
// same or a later origin, so a list costs time in the square of its length
// to apply: an update can make a list long with one long chain of origins,
// or many items after the same one. lists finds the list of each item of
// the doc and an update, by its parent and key or by the item it follows,
// as Yjs would, and tells which items it cannot place: those would wait
// for structs not received yet.
type lists struct {
	recs  []record
	fresh []bool // not in the doc yet
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

// newLists takes the records of the doc and of an update for it, at known,
// leaving out those of the update the doc has.
func newLists(doc, update []record, known map[uint64]uint64) *lists {
	l := &lists{byClient: map[uint64][]int{}}
	add := func(r record, fresh bool) {
		l.byClient[r.at.client] = append(l.byClient[r.at.client], len(l.recs))
		l.recs = append(l.recs, r)
		l.fresh = append(l.fresh, fresh)
	}
	for _, r := range doc {
		add(r, false)
	}
	for _, r := range update {
		if r.at.clock+r.length > known[r.at.client] {
			add(r, true)
		}
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

// step is what record i's list comes from: another record, j, or, when
// final, its own list, or none it can be placed in.
func (l *lists) step(i int) (j int, final bool, list string, ok bool) {
	r := l.recs[i]
	if !r.item {
		return 0, true, "", true // garbage: in no list
	}
	dep := r.parent
	if r.origin != nil {
		dep = r.origin
	}
	if dep == nil {
		return 0, true, "r " + r.root + "\x00" + r.key, true
	}
	// A client's structs come in order: one cannot follow its own later one.
	if dep.client == r.at.client && dep.clock >= r.at.clock {
		return 0, true, "", false
	}
	j = l.find(*dep)
	if j < 0 {
		return 0, true, "", false
	}
	if r.origin == nil {
		return 0, true, fmt.Sprintf("p %d %d\x00%s", dep.client, dep.clock, r.key), true
	}
	return j, false, "", false
}

// resolve finds the list of every record, without recursion: a chain of
// origins can be as long as the doc.
func (l *lists) resolve() {
	for i := range l.recs {
		stack := []int{i}
		for len(stack) > 0 {
			k := stack[len(stack)-1]
			if l.state[k] == done {
				stack = stack[:len(stack)-1]
				continue
			}
			j, final, list, ok := l.step(k)
			switch {
			case final:
				l.finish(k, list, ok)
			case l.state[j] == done:
				l.finish(k, l.list[j], l.placed[j])
			case l.state[j] == seen:
				l.finish(k, "", false) // a cycle of origins
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
// one makes a list longer than MaxListItems.
func (l *lists) check() (missing, long bool) {
	l.resolve()
	lengths := map[string]int{}
	for i, r := range l.recs {
		if l.fresh[i] && !l.placed[i] {
			missing = true
		}
		if r.item && l.list[i] != "" {
			lengths[l.list[i]]++
		}
	}
	for i := range l.recs {
		if l.fresh[i] && lengths[l.list[i]] > MaxListItems {
			long = true
		}
	}
	return missing, long
}
