package meta

import (
	"math"
	"sort"

	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
)

// Yjs and ygo encode one doc in different sizes: Yjs merges the runs of
// structs a doc deletes, and ygo keeps each. So the limit on a doc is on a
// measure every peer works out alike from its structs, and that neither
// encoding passes: a live item takes what Yjs writes for it, each clock of
// deleted content deadBytes, which covers the struct and deleted range ygo
// may write for it, and each client clientBytes plus its id twice.
//
// Applying an update deletes more than it says: of the items under one key
// of a map, all but the last, and what the maps among them hold. So an item
// that could be deleted that way, being in a list of more than one item, or
// in a map that could be, takes deadBytes a clock at least, deleted or not,
// and a doc measures no less for being applied. Such an item of more than
// one clock, a run of values, may also be split into items of its own, by
// a deletion of part of it or an item that follows one of its values: each
// piece takes what Yjs writes for it, up to splitBytes more than its part
// of the run, or deadBytes a clock. So the run takes its bytes, splitBytes
// for each clock but one, and deadBytes a clock, which no pieces pass.
const (
	deadBytes   = 96
	clientBytes = 12
	splitBytes  = 16
)

// What may become of an item, by what applying the records can delete.
const (
	stays = iota
	mayGo
	gone
)

// size is the measure of the doc the records make, resolved, with the
// deleted ranges of all of sets, by client.
func (l *lists) size(sets ...map[uint64][][2]uint64) int {
	dead := merged(sets...)
	fate := l.fates(dead)
	n := 2
	clients := map[uint64]bool{}
	for i, r := range l.recs {
		clients[r.at.client] = true
		all := deadBytes * int(r.length)
		switch {
		case fate[i] == gone:
			n += all
		case fate[i] == stays:
			n += r.bytes
		case r.length > 1:
			n += r.bytes + splitBytes*int(r.length-1) + all
		default:
			n += max(r.bytes, all)
		}
	}
	for c := range dead {
		clients[c] = true
	}
	for c := range clients {
		n += clientBytes + 2*varLen(c)
	}
	return n
}

// fates tells what may become of each record, with dead deleted.
func (l *lists) fates(dead map[uint64][][2]uint64) []byte {
	deleted := make([]uint64, len(l.recs))
	// Lists of more than one item, or of one partly deleted, count two.
	items := map[string]int{}
	for i, r := range l.recs {
		deleted[i] = r.length
		if r.item && !r.deleted {
			deleted[i] = overlap(dead[r.at.client], r.at.clock, r.length)
		}
		if l.list[i] != "" {
			items[l.list[i]] += 1 + min(1, int(deleted[i]))
		}
	}
	fate := make([]byte, len(l.recs))
	for _, i := range l.order {
		r, p := l.recs[i], l.parent[i]
		switch {
		case !r.item || deleted[i] == r.length || p >= 0 && (!l.recs[p].item || fate[p] == gone):
			fate[i] = gone
		case p >= 0 && fate[p] == mayGo || items[l.list[i]] > 1:
			fate[i] = mayGo
		}
	}
	return fate
}

// DocSize is the measure CheckUpdate limits, of doc, a metadata doc.
func DocSize(doc *crdt.Doc) int {
	s, err := scan(crdt.EncodeStateAsUpdateV1(doc, nil))
	if err != nil {
		return math.MaxInt
	}
	l := newLists(s.recs, nil)
	l.resolve()
	return l.size(s.deleted)
}

// merged sorts and joins each client's ranges of all of sets.
func merged(sets ...map[uint64][][2]uint64) map[uint64][][2]uint64 {
	out := map[uint64][][2]uint64{}
	for _, d := range sets {
		for c, rs := range d {
			out[c] = append(out[c], rs...)
		}
	}
	for c, rs := range out {
		sort.Slice(rs, func(a, b int) bool { return rs[a][0] < rs[b][0] })
		j := 0
		for _, r := range rs[1:] {
			if last := &rs[j]; r[0] <= last[0]+last[1] {
				last[1] = max(last[1], r[0]+r[1]-last[0])
			} else {
				j++
				rs[j] = r
			}
		}
		out[c] = rs[:j+1]
	}
	return out
}

// overlap is how much of [clock, clock+length) ranges, sorted and joined,
// cover.
func overlap(ranges [][2]uint64, clock, length uint64) uint64 {
	end := clock + length
	i := sort.Search(len(ranges), func(i int) bool { return ranges[i][0]+ranges[i][1] > clock })
	var n uint64
	for ; i < len(ranges) && ranges[i][0] < end; i++ {
		n += min(end, ranges[i][0]+ranges[i][1]) - max(clock, ranges[i][0])
	}
	return n
}

// anyLen is how many bytes Yjs (lib0) writes for a value, as decoded.
func anyLen(v any) int {
	switch v := v.(type) {
	case nil, bool:
		return 1
	case int64:
		return numberLen(float64(v))
	case float32:
		return numberLen(float64(v))
	case float64:
		return numberLen(v)
	case encoding.BigInt:
		return 9
	case string:
		return 1 + strLen(v)
	case []byte:
		return 1 + varLen(uint64(len(v))) + len(v)
	case []any:
		n := 1 + varLen(uint64(len(v)))
		for _, x := range v {
			n += anyLen(x)
		}
		return n
	case map[string]any:
		n := 1 + varLen(uint64(len(v)))
		for k, x := range v {
			n += strLen(k) + anyLen(x)
		}
		return n
	}
	return 9
}

// numberLen is how many bytes lib0 writes for a number, with its tag: a
// varint for an integer of 31 bits, else a float32 when it holds it, else a
// float64.
func numberLen(x float64) int {
	if x == math.Trunc(x) && math.Abs(x) <= math.MaxInt32 {
		n, a := 2, uint64(math.Abs(x))>>6
		for ; a > 0; a >>= 7 {
			n++
		}
		return n
	}
	if float64(float32(x)) == x {
		return 5
	}
	return 9
}

// strLen is how many bytes a string takes, with its length.
func strLen(s string) int { return varLen(uint64(len(s))) + len(s) }
