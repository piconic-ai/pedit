package meta

import (
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
)

// estimate is what CheckUpdate takes the doc's size with update to be.
func estimate(t *testing.T, doc *crdt.Doc, update []byte) int {
	t.Helper()
	u, err := scan(update)
	if err != nil {
		t.Fatal(err)
	}
	known := map[uint64]uint64{}
	for c, clock := range doc.StateVector() {
		known[uint64(c)] = clock
	}
	state := crdt.EncodeStateAsUpdateV1(doc, nil)
	have, err := scan(state)
	if err != nil {
		t.Fatal(err)
	}
	l := newLists(have.recs, freshOf(u.recs, known))
	l.check()
	n, err := sizeAfter(len(state), have, u, l, update, doc.StateVector())
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestSizeAfterDoesNotCountLow(t *testing.T) {
	// Peers edit comments at random; every update is checked, and the doc
	// it makes must be no larger than the estimate.
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
		want := estimate(t, host, update)
		if err := crdt.ApplyUpdateV1(host, update, nil); err != nil {
			t.Fatal(err)
		}
		got := len(crdt.EncodeStateAsUpdateV1(host, nil))
		if got > want {
			t.Fatalf("round %d: the doc took %d bytes, more than the %d estimated", round, got, want)
		}
		worst = max(worst, float64(want)/float64(got))
	}
	t.Logf("estimates at most %.2f times the size", worst)
}

func TestSizeAfterOfAStateToANewPeer(t *testing.T) {
	host := crdt.New()
	m := host.GetMap(CommentsKey)
	for i := range 2000 {
		host.Transact(func(txn *crdt.Transaction) { m.Set(txn, fmt.Sprintf("k%d", i%300), i) })
	}
	state := crdt.EncodeStateAsUpdateV1(host, nil)
	if n := estimate(t, crdt.New(), state); n > len(state)+64 {
		t.Fatalf("estimated %d for a state of %d", n, len(state))
	}
}

func TestSizeAfterOfDeletionsThatSplitARun(t *testing.T) {
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
	want := estimate(t, host, update)
	if err := crdt.ApplyUpdateV1(host, update, nil); err != nil {
		t.Fatal(err)
	}
	if got := len(crdt.EncodeStateAsUpdateV1(host, nil)); got > want {
		t.Fatalf("the doc took %d bytes, more than the %d estimated", got, want)
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
