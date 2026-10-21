package meta

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
)

// measure is the measure of doc: size, from its state.
func measure(t *testing.T, doc *crdt.Doc) int {
	t.Helper()
	s, err := scan(crdt.EncodeStateAsUpdateV1(doc, nil))
	if err != nil {
		t.Fatal(err)
	}
	l := newLists(s.recs, nil)
	l.resolve()
	return l.size(s.deleted)
}

func TestNeitherEncodingPassesTheMeasure(t *testing.T) {
	// Peers edit comments at random; every update is checked, and the doc it
	// makes, encoded, must be no larger than its measure.
	rng := rand.New(rand.NewPCG(1, 2))
	host := crdt.New()
	peers := make([]*crdt.Doc, 4)
	for i := range peers {
		peers[i] = crdt.New()
	}
	worst := 0.0
	for round := range 400 {
		p := peers[rng.IntN(len(peers))]
		// Catch up first, as a peer would, with a step2 from the host.
		if err := crdt.ApplyUpdateV1(p, crdt.EncodeStateAsUpdateV1(host, p.StateVector()), nil); err != nil {
			t.Fatal(err)
		}
		before := p.StateVector()
		m := p.GetMap(CommentsKey)
		p.Transact(func(txn *crdt.Transaction) {
			for range 1 + rng.IntN(8) {
				key := fmt.Sprintf("k%d", rng.IntN(40))
				if rng.IntN(4) == 0 {
					m.Delete(txn, key)
				} else {
					m.Set(txn, key, fmt.Sprintf("%d-%d", round, rng.IntN(1000)))
				}
			}
		})
		update := crdt.EncodeStateAsUpdateV1(p, before)
		if rng.IntN(5) == 0 {
			update = crdt.EncodeStateAsUpdateV1(p, nil) // a whole state, mostly known
		}
		if err := CheckUpdate(host, update); err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		if err := crdt.ApplyUpdateV1(host, update, nil); err != nil {
			t.Fatal(err)
		}
		got, want := len(crdt.EncodeStateAsUpdateV1(host, nil)), measure(t, host)
		if got > want {
			t.Fatalf("round %d: the doc took %d bytes, more than its measure, %d", round, got, want)
		}
		worst = max(worst, float64(want)/float64(got))
	}
	t.Logf("the measure is at most %.2f times the size", worst)
}

func TestTheMeasureOfDeletionsThatSplitARun(t *testing.T) {
	// A run of values, as an UndoManager keeps them, then a deletion of
	// every other value: each one splits the run.
	n := 900
	run := encodeRun(n)
	host := crdt.New()
	if err := CheckUpdate(host, run); err != nil {
		t.Fatal(err)
	}
	if err := crdt.ApplyUpdateV1(host, run, nil); err != nil {
		t.Fatal(err)
	}
	var ranges [][2]uint64
	for i := 1; i < n-1; i += 2 {
		ranges = append(ranges, [2]uint64{uint64(i), 1})
	}
	update := encodeDeletes(7, ranges)
	if err := CheckUpdate(host, update); err != nil {
		t.Fatal(err)
	}
	if err := crdt.ApplyUpdateV1(host, update, nil); err != nil {
		t.Fatal(err)
	}
	if got, want := len(crdt.EncodeStateAsUpdateV1(host, nil)), measure(t, host); got > want {
		t.Fatalf("the doc took %d bytes, more than its measure, %d", got, want)
	}
}

// encodeRun is an update of client 7: one item of n values under key "k".
func encodeRun(n int) []byte {
	e := encoding.NewEncoder()
	for _, v := range []uint64{1, 1, 7, 0} {
		e.WriteVarUint(v)
	}
	e.WriteUint8(hasParentSub | refAny)
	e.WriteVarUint(1)
	e.WriteVarString(CommentsKey)
	e.WriteVarString("k")
	e.WriteVarUint(uint64(n))
	for i := range n {
		e.WriteUint8(125)
		e.WriteVarInt(int64(i))
	}
	e.WriteVarUint(0)
	return e.Bytes()
}

// encodeDeletes is an update that only deletes ranges of client.
func encodeDeletes(client uint64, ranges [][2]uint64) []byte {
	e := encoding.NewEncoder()
	e.WriteVarUint(0)
	e.WriteVarUint(1)
	e.WriteVarUint(client)
	e.WriteVarUint(uint64(len(ranges)))
	for _, r := range ranges {
		e.WriteVarUint(r[0])
		e.WriteVarUint(r[1])
	}
	return e.Bytes()
}

func TestInsertsInsideARunOfValuesStayCheap(t *testing.T) {
	// From review: 65,000 values in one item, then items inserted inside
	// it, took ygo 12s to apply. The run weighs its length now.
	if err := CheckUpdate(crdt.New(), encodeRun(65000)); err == nil {
		t.Fatal("took a run of 65,000 values")
	}
	host := crdt.New()
	if err := crdt.ApplyUpdateV1(host, encodeRun(1000), nil); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	taken := 0
	for i := range 200 {
		e := encoding.NewEncoder()
		for _, v := range []uint64{1, 1, uint64(100 + i), 0} {
			e.WriteVarUint(v)
		}
		e.WriteUint8(hasOrigin | refAny)
		e.WriteVarUint(7)
		e.WriteVarUint(uint64(5 * i))
		e.WriteVarUint(1)
		e.WriteUint8(125)
		e.WriteVarInt(1)
		e.WriteVarUint(0)
		if CheckUpdate(host, e.Bytes()) != nil {
			continue
		}
		taken++
		if err := crdt.ApplyUpdateV1(host, e.Bytes(), nil); err != nil {
			t.Fatal(err)
		}
	}
	// The first one overwrote the run, which ygo then keeps as deleted
	// content: cheap to split.
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("%d updates took %v", taken, d)
	}
	// In one update, the run is not deleted yet when items go inside it.
	if err := CheckUpdate(crdt.New(), runWithInserts(1000, 200)); err == nil {
		t.Fatal("took a run of 1,000 values with 200 items inside it")
	}
}

// runWithInserts is encodeRun(n), with k items of other clients inserted
// after values inside the run, in one update.
func runWithInserts(n, k int) []byte {
	e := encoding.NewEncoder()
	e.WriteVarUint(uint64(1 + k))
	for _, v := range []uint64{1, 7, 0} {
		e.WriteVarUint(v)
	}
	e.WriteUint8(hasParentSub | refAny)
	e.WriteVarUint(1)
	e.WriteVarString(CommentsKey)
	e.WriteVarString("k")
	e.WriteVarUint(uint64(n))
	for i := range n {
		e.WriteUint8(125)
		e.WriteVarInt(int64(i))
	}
	for i := range k {
		for _, v := range []uint64{1, uint64(100 + i), 0} {
			e.WriteVarUint(v)
		}
		e.WriteUint8(hasOrigin | refAny)
		e.WriteVarUint(7)
		e.WriteVarUint(uint64(i * n / k))
		e.WriteVarUint(1)
		e.WriteUint8(125)
		e.WriteVarInt(1)
	}
	e.WriteVarUint(0)
	return e.Bytes()
}

func TestAnyLenIsWhatLib0Writes(t *testing.T) {
	// From review: integers were counted without their tag.
	for _, v := range []any{
		nil, true, int64(0), int64(63), int64(64), int64(-8192), int64(1 << 30), float64(1.5),
		float64(1e300), "héllo", []byte{1, 2}, []any{int64(0), int64(0), "x"},
		map[string]any{"a": int64(1), "b": []any{false}},
	} {
		e := encoding.NewEncoder()
		e.WriteAny(v)
		if got, want := anyLen(v), len(e.Bytes()); got != want {
			t.Errorf("anyLen(%#v) = %d; lib0 writes %d", v, got, want)
		}
	}
}

// predicted is the measure CheckUpdate takes of doc with update applied.
func predicted(t *testing.T, doc *crdt.Doc, update []byte) int {
	t.Helper()
	u, err := scan(update)
	if err != nil {
		t.Fatal(err)
	}
	have, err := scan(crdt.EncodeStateAsUpdateV1(doc, nil))
	if err != nil {
		t.Fatal(err)
	}
	known := map[uint64]uint64{}
	for c, clock := range doc.StateVector() {
		known[uint64(c)] = clock
	}
	l := newLists(have.recs, freshOf(u.recs, known))
	l.resolve()
	return l.size(have.deleted, u.deleted)
}

func TestConcurrentSetsMeasureNoMoreThanForeseen(t *testing.T) {
	// From review: applying a set of a key another peer set too deletes one
	// of them, and what a map set holds, which no update says. Peers that
	// seldom catch up set values and maps under the same keys; the doc
	// applied measures no more than CheckUpdate foresaw.
	rng := rand.New(rand.NewPCG(3, 4))
	host := crdt.New()
	peers := make([]*crdt.Doc, 3)
	for i := range peers {
		peers[i] = crdt.New()
	}
	for round := range 300 {
		p := peers[rng.IntN(len(peers))]
		if rng.IntN(4) == 0 {
			if err := crdt.ApplyUpdateV1(p, crdt.EncodeStateAsUpdateV1(host, p.StateVector()), nil); err != nil {
				t.Fatal(err)
			}
		}
		before := p.StateVector()
		m := p.GetMap(CommentsKey)
		p.Transact(func(txn *crdt.Transaction) {
			for range 1 + rng.IntN(4) {
				key := fmt.Sprintf("k%d", rng.IntN(6))
				switch rng.IntN(4) {
				case 0:
					m.Delete(txn, key)
				case 1:
					inner := crdt.NewMapPrelim()
					m.Set(txn, key, inner)
					inner.Set(txn, "body", fmt.Sprintf("%d", round))
					inner.Set(txn, "n", int64(rng.IntN(1000)))
				default:
					m.Set(txn, key, int64(rng.IntN(1<<20)))
				}
			}
		})
		update := crdt.EncodeStateAsUpdateV1(p, before)
		if err := CheckUpdate(host, update); err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		want := predicted(t, host, update)
		if err := crdt.ApplyUpdateV1(host, update, nil); err != nil {
			t.Fatal(err)
		}
		if got := DocSize(host); got > want {
			t.Fatalf("round %d: the doc measures %d, past the %d foreseen", round, got, want)
		}
		if got, want := len(crdt.EncodeStateAsUpdateV1(host, nil)), DocSize(host); got > want {
			t.Fatalf("round %d: the doc took %d bytes, more than its measure, %d", round, got, want)
		}
	}
}

func TestAConcurrentSetAtTheLimitIsRefused(t *testing.T) {
	// From review: k=false and padding to just under the limit, then another
	// client's k=true, with no deletions, passed and took the doc past it.
	padded := func(n int) *crdt.Doc {
		doc := crdt.New()
		comments := doc.GetMap(CommentsKey) // not inside Transact: ygo would deadlock
		doc.Transact(func(txn *crdt.Transaction) {
			comments.Set(txn, "k", false)
			comments.Set(txn, "pad", strings.Repeat("x", n))
		})
		return doc
	}
	n := MaxDocBytes - 300
	host := padded(n + MaxDocBytes - 100 - DocSize(padded(n)))
	if got := DocSize(host); got != MaxDocBytes-100 {
		t.Fatalf("padded to %d", got)
	}
	peer := crdt.New()
	theirs := peer.GetMap(CommentsKey)
	peer.Transact(func(txn *crdt.Transaction) { theirs.Set(txn, "k", true) })
	update := crdt.EncodeStateAsUpdateV1(peer, nil)
	if err := CheckUpdate(host, update); err == nil {
		t.Fatal("took it")
	}
}

func TestAnItemInsideARunAtTheLimitIsRefused(t *testing.T) {
	// From review: a run of a long string and false, under a key, and
	// another client's item following its first value, split it in two
	// pieces, the second of which took deadBytes on its own: the doc passed
	// the limit with no deletions at all.
	host := crdt.New()
	comments := host.GetMap(CommentsKey) // not inside Transact: ygo would deadlock
	host.Transact(func(txn *crdt.Transaction) {
		comments.Set(txn, "pad", strings.Repeat("x", MaxDocBytes-1200))
	})
	e := encoding.NewEncoder()
	e.WriteVarUint(2)
	// Client 7: one item of two values under key "k".
	for _, v := range []uint64{1, 7, 0} {
		e.WriteVarUint(v)
	}
	e.WriteUint8(hasParentSub | refAny)
	e.WriteVarUint(1)
	e.WriteVarString(CommentsKey)
	e.WriteVarString("k")
	e.WriteVarUint(2)
	e.WriteAny(strings.Repeat("x", 1000))
	e.WriteAny(false)
	// Client 8: an item after its first value.
	for _, v := range []uint64{1, 8, 0} {
		e.WriteVarUint(v)
	}
	e.WriteUint8(hasOrigin | refAny)
	e.WriteVarUint(7)
	e.WriteVarUint(0)
	e.WriteVarUint(1)
	e.WriteAny(true)
	e.WriteVarUint(0)
	update := e.Bytes()
	checked := CheckUpdate(host, update)
	want := predicted(t, host, update)
	if err := crdt.ApplyUpdateV1(host, update, nil); err != nil {
		t.Fatal(err)
	}
	got := DocSize(host)
	if got > want {
		t.Fatalf("the doc measures %d, past the %d foreseen", got, want)
	}
	if checked == nil && got > MaxDocBytes {
		t.Fatalf("took it, and the doc measures %d", got)
	}
}

func TestRunsSplitByItemsMeasureNoMoreThanForeseen(t *testing.T) {
	// Runs of values of all sizes, and items following any of their values,
	// from other clients: the doc applied measures no more than foreseen.
	rng := rand.New(rand.NewPCG(5, 6))
	for round := range 200 {
		host := crdt.New()
		e := encoding.NewEncoder()
		n := 2 + rng.IntN(6)
		followers := 1 + rng.IntN(3)
		e.WriteVarUint(uint64(1 + followers))
		for _, v := range []uint64{1, 7, 0} {
			e.WriteVarUint(v)
		}
		e.WriteUint8(hasParentSub | refAny)
		e.WriteVarUint(1)
		e.WriteVarString(CommentsKey)
		e.WriteVarString("k")
		e.WriteVarUint(uint64(n))
		for range n {
			if rng.IntN(2) == 0 {
				e.WriteAny(strings.Repeat("x", rng.IntN(300)))
			} else {
				e.WriteAny(rng.IntN(2) == 0)
			}
		}
		for f := range followers {
			for _, v := range []uint64{1, uint64(20 + f), 0} {
				e.WriteVarUint(v)
			}
			e.WriteUint8(hasOrigin | refAny)
			e.WriteVarUint(7)
			e.WriteVarUint(uint64(rng.IntN(n)))
			e.WriteVarUint(1)
			e.WriteAny(int64(f))
		}
		e.WriteVarUint(0)
		update := e.Bytes()
		if err := CheckUpdate(host, update); err != nil {
			t.Fatalf("round %d: %v", round, err)
		}
		want := predicted(t, host, update)
		if err := crdt.ApplyUpdateV1(host, update, nil); err != nil {
			t.Fatal(err)
		}
		if got := DocSize(host); got > want {
			t.Fatalf("round %d: the doc measures %d, past the %d foreseen", round, got, want)
		}
	}
}
