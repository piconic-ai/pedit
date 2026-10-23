package meta_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
	"github.com/reearth/ygo/encoding"
)

// updatesOf records the updates a doc makes.
func updatesOf(doc *crdt.Doc) *[][]byte {
	var out [][]byte
	doc.OnUpdate(func(u []byte, _ any) { out = append(out, u) })
	return &out
}

func setThread(doc *crdt.Doc, id, body string) {
	comments := doc.GetMap(meta.CommentsKey)
	doc.Transact(func(txn *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		comments.Set(txn, id, thread)
		thread.Set(txn, meta.QuoteKey, body)
	})
}

func TestCheckUpdateTakesAnHonestUpdate(t *testing.T) {
	guest, host := crdt.New(), crdt.New()
	updates := updatesOf(guest)
	setThread(guest, "c1", "hello")
	for _, u := range *updates {
		if err := meta.CheckUpdate(host, u); err != nil {
			t.Fatal(err)
		}
		if err := crdt.ApplyUpdateV1(host, u, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCheckUpdateRefusesAGap(t *testing.T) {
	guest, host := crdt.New(), crdt.New()
	updates := updatesOf(guest)
	setThread(guest, "c1", "one")
	setThread(guest, "c2", "two")
	// The second update without the first: Yjs would keep it pending.
	err := meta.CheckUpdate(host, (*updates)[1])
	if !errors.Is(err, meta.ErrRefused) || !errors.Is(err, protocol.ErrRetryLater) {
		t.Fatalf("CheckUpdate = %v", err)
	}
}

func TestCheckUpdateRefusesDeletionsOfWhatItHasNot(t *testing.T) {
	// From review: no structs, and a deletion of client 999's clocks 0-9,
	// which ygo would keep pending and send on with the doc.
	update := []byte{0, 1, 0xe7, 0x07, 1, 0, 10}
	err := meta.CheckUpdate(crdt.New(), update)
	if !errors.Is(err, meta.ErrRefused) || !errors.Is(err, protocol.ErrRetryLater) {
		t.Fatalf("CheckUpdate = %v", err)
	}
}

func TestEveryPeerCanTakeTheLargestDocItKeeps(t *testing.T) {
	// The file's headers in a FilesDoc frame are a few bytes.
	if protocol.FrameBytes(meta.MaxDocBytes+64) > protocol.MaxFrameBytes {
		t.Fatalf("a doc of %d bytes does not fit a frame", meta.MaxDocBytes)
	}
}

func TestCheckUpdateRefusesTooManyOperations(t *testing.T) {
	guest, host := crdt.New(), crdt.New()
	m := guest.GetMap(meta.CommentsKey)
	guest.Transact(func(txn *crdt.Transaction) {
		for range meta.MaxClientClock + 1 {
			m.Set(txn, "k", 1)
		}
	})
	if err := meta.CheckUpdate(host, crdt.EncodeStateAsUpdateV1(guest, nil)); !errors.Is(err, meta.ErrRefused) {
		t.Fatalf("CheckUpdate = %v", err)
	}
}

func TestCheckUpdateRefusesADocTooLarge(t *testing.T) {
	guest, host := crdt.New(), crdt.New()
	setThread(guest, "c1", strings.Repeat("x", meta.MaxDocBytes))
	if err := meta.CheckUpdate(host, crdt.EncodeStateAsUpdateV1(guest, nil)); !errors.Is(err, meta.ErrRefused) {
		t.Fatalf("CheckUpdate = %v", err)
	}
}

func TestCheckUpdateRefusesGarbage(t *testing.T) {
	if err := meta.CheckUpdate(crdt.New(), []byte{0xff, 0xff, 0xff}); !errors.Is(err, meta.ErrRefused) {
		t.Fatalf("CheckUpdate = %v", err)
	}
}

func FuzzCheckUpdate(f *testing.F) {
	guest := crdt.New()
	setThread(guest, "c1", "hello")
	f.Add(crdt.EncodeStateAsUpdateV1(guest, nil))
	f.Fuzz(func(t *testing.T, update []byte) {
		_ = meta.CheckUpdate(crdt.New(), update)
	})
}

func TestCheckLimitsMatchPackagesProtocol(t *testing.T) {
	data, err := os.ReadFile("../../packages/testdata/meta-limits.json")
	if err != nil {
		t.Fatal(err)
	}
	var limits struct {
		MaxDocBytes    int `json:"maxDocBytes"`
		MaxClientClock int `json:"maxClientClock"`
		MaxListWork    int `json:"maxListWork"`
	}
	if err := json.Unmarshal(data, &limits); err != nil {
		t.Fatal(err)
	}
	if limits.MaxDocBytes != meta.MaxDocBytes || limits.MaxClientClock != meta.MaxClientClock || limits.MaxListWork != meta.MaxListWork {
		t.Fatalf("meta-limits.json says %+v", limits)
	}
}

// concurrentSets is an update of n clients each setting the same key of the
// comments at once, as no honest room does for long.
func concurrentSets(t *testing.T, n int) []byte {
	t.Helper()
	all := crdt.New()
	for range n {
		peer := crdt.New()
		m := peer.GetMap(meta.CommentsKey)
		peer.Transact(func(txn *crdt.Transaction) { m.Set(txn, "k", 1) })
		if err := crdt.ApplyUpdateV1(all, crdt.EncodeStateAsUpdateV1(peer, nil), nil); err != nil {
			t.Fatal(err)
		}
	}
	return crdt.EncodeStateAsUpdateV1(all, nil)
}

func TestCheckUpdateRefusesALongList(t *testing.T) {
	// From review: Yjs and ygo take time in the square of the items of one
	// list; 24,000 set at once on one key took 31s to apply.
	most := 1
	for (most+1)*(most+1) <= meta.MaxListWork {
		most++
	}
	if err := meta.CheckUpdate(crdt.New(), concurrentSets(t, most)); err != nil {
		t.Fatalf("refused %d: %v", most, err)
	}
	err := meta.CheckUpdate(crdt.New(), concurrentSets(t, most+1))
	if !errors.Is(err, meta.ErrRefused) || !strings.Contains(err.Error(), "lists") {
		t.Fatalf("CheckUpdate = %v", err)
	}
	// Nor a few at a time.
	host := crdt.New()
	if err := crdt.ApplyUpdateV1(host, concurrentSets(t, most), nil); err != nil {
		t.Fatal(err)
	}
	if err := meta.CheckUpdate(host, concurrentSets(t, 1)); !errors.Is(err, meta.ErrRefused) {
		t.Fatalf("CheckUpdate = %v", err)
	}
}

func TestCheckUpdateRefusesAListMadeLongAlongAChain(t *testing.T) {
	// From review: client 1 sets a key n times, then each of n clients
	// inserts one item after one of those: no two items follow the same
	// one, but the list is 2n long, and took 43s to apply for n = 20,000.
	n := 768 // a list of 1,536: more work than MaxListWork
	var blocks []block
	chain := block{client: 1}
	for i := range n {
		it := item{}
		if i > 0 {
			it.origin = &[2]uint64{1, uint64(i - 1)}
		}
		chain.items = append(chain.items, it)
	}
	blocks = append(blocks, chain)
	for i := range n {
		blocks = append(blocks, block{client: uint64(1000 + i), items: []item{{origin: &[2]uint64{1, uint64(i)}}}})
	}
	err := meta.CheckUpdate(crdt.New(), encodeUpdate(blocks...))
	if !errors.Is(err, meta.ErrRefused) || !strings.Contains(err.Error(), "lists") {
		t.Fatalf("CheckUpdate = %v", err)
	}
}

// runOfValues is an update of one item of n values under key "k", as Yjs
// keeps a run of overwritten values when it does not collect them, deleted
// when deleted is set.
func runOfValues(n int, deleted bool) []byte {
	e := encoding.NewEncoder()
	for _, v := range []uint64{1, 1, 7, 0} {
		e.WriteVarUint(v)
	}
	e.WriteUint8(0x20 | 8)
	e.WriteVarUint(1)
	e.WriteVarString(meta.CommentsKey)
	e.WriteVarString("k")
	e.WriteVarUint(uint64(n))
	for i := range n {
		e.WriteUint8(125)
		e.WriteVarInt(int64(i))
	}
	if deleted {
		for _, v := range []uint64{1, 7, 1, 0, uint64(n - 1)} {
			e.WriteVarUint(v)
		}
	} else {
		e.WriteVarUint(0)
	}
	return e.Bytes()
}

func TestCheckUpdateWeighsARunOfValuesByItsLength(t *testing.T) {
	// From review: an honest peer with an UndoManager, or without garbage
	// collection, sends overwritten values as a run, which passes; one of
	// 65,000 counted as one item, and ygo copied the rest of it each time
	// an item went inside it.
	if err := meta.CheckUpdate(crdt.New(), runOfValues(5, true)); err != nil {
		t.Fatal(err)
	}
	err := meta.CheckUpdate(crdt.New(), runOfValues(1100, false))
	if !errors.Is(err, meta.ErrRefused) || !strings.Contains(err.Error(), "lists") {
		t.Fatalf("CheckUpdate = %v", err)
	}
}

func TestCheckUpdateTakesTheStateOfALargeDoc(t *testing.T) {
	// From review: a doc near the limit, with many deletions, was refused
	// as a whole by a new peer, and its state again by peers that had it.
	host := crdt.New()
	m := host.GetMap(meta.CommentsKey)
	host.Transact(func(txn *crdt.Transaction) {
		for i := range 31 {
			m.Set(txn, fmt.Sprintf("q%d", i), strings.Repeat("x", 20000))
		}
	})
	for i := range 6000 {
		host.Transact(func(txn *crdt.Transaction) { m.Set(txn, fmt.Sprintf("k%d", i), i) })
	}
	for i := range 3000 {
		host.Transact(func(txn *crdt.Transaction) { m.Delete(txn, fmt.Sprintf("k%d", 2*i)) })
	}
	state := crdt.EncodeStateAsUpdateV1(host, nil)
	if n := meta.DocSize(host); n > meta.MaxDocBytes || n < meta.MaxDocBytes*3/4 {
		t.Fatalf("a doc of %d by its measure", n)
	}
	if err := meta.CheckUpdate(crdt.New(), state); err != nil {
		t.Fatalf("a new peer: %v", err)
	}
	if err := meta.CheckUpdate(host, state); err != nil {
		t.Fatalf("a peer that has it: %v", err)
	}
}

func TestCheckUpdateTakesAStructItHasTheStartOf(t *testing.T) {
	// From review: a deleted run of which the doc has the first items.
	peer := crdt.New()
	m := peer.GetMap(meta.CommentsKey)
	updates := updatesOf(peer)
	for i := range 4 {
		peer.Transact(func(txn *crdt.Transaction) { m.Set(txn, "k", i) })
	}
	host := crdt.New()
	for _, u := range (*updates)[:2] {
		if err := crdt.ApplyUpdateV1(host, u, nil); err != nil {
			t.Fatal(err)
		}
	}
	if err := meta.CheckUpdate(host, crdt.EncodeStateAsUpdateV1(peer, nil)); err != nil {
		t.Fatal(err)
	}
}

func TestCheckUpdateRefusesWhatWouldWait(t *testing.T) {
	// From review: each of these passed, and ygo and Yjs kept part of it
	// pending.
	for name, update := range map[string][]byte{
		"one client twice": encodeUpdate(block{client: 5, items: []item{{}}}, block{client: 5, clock: 10, items: []item{{}}}),
		"a cycle of origins": encodeUpdate(
			block{client: 5, items: []item{{origin: &[2]uint64{6, 0}}}},
			block{client: 6, items: []item{{origin: &[2]uint64{5, 0}}}},
		),
		"a cycle of parents": encodeUpdate(
			block{client: 5, items: []item{{parent: &[2]uint64{6, 0}}}},
			block{client: 6, items: []item{{parent: &[2]uint64{5, 0}}}},
		),
		// Client 5's second item follows its first, which is in 6's, in 5's
		// second: a cycle only with the order of clocks.
		"a cycle through a client's clocks": encodeUpdate(
			block{client: 5, items: []item{{parent: &[2]uint64{6, 0}}, {}}},
			block{client: 6, items: []item{{parent: &[2]uint64{5, 1}}}},
		),
		"following itself":       encodeUpdate(block{client: 5, items: []item{{origin: &[2]uint64{5, 0}}}}),
		"following a later item": encodeUpdate(block{client: 5, items: []item{{origin: &[2]uint64{5, 1}}, {}}}),
	} {
		err := meta.CheckUpdate(crdt.New(), update)
		if !errors.Is(err, meta.ErrRefused) {
			t.Errorf("%s: CheckUpdate = %v", name, err)
		}
	}
	// Following an item later in the update, of another client, is fine.
	ok := encodeUpdate(
		block{client: 5, items: []item{{origin: &[2]uint64{6, 0}}}},
		block{client: 6, items: []item{{}}},
	)
	if err := meta.CheckUpdate(crdt.New(), ok); err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	if err := crdt.ApplyUpdateV1(doc, ok, nil); err != nil || doc.PendingStats().Items != 0 {
		t.Fatalf("applied with %v, %+v pending", err, doc.PendingStats())
	}
}

// block is a client's structs in an update, from clock: items set on key
// "k" of the comments, after origin, or first.
type block struct {
	client, clock uint64
	items         []item
}

// item follows origin, or is first under key "k" of parent, or of the
// comments.
type item struct{ origin, parent *[2]uint64 }

// encodeUpdate writes blocks as a V1 update, as no honest peer would.
func encodeUpdate(blocks ...block) []byte {
	e := encoding.NewEncoder()
	e.WriteVarUint(uint64(len(blocks)))
	for _, b := range blocks {
		e.WriteVarUint(uint64(len(b.items)))
		e.WriteVarUint(b.client)
		e.WriteVarUint(b.clock)
		for _, it := range b.items {
			if it.origin != nil {
				e.WriteUint8(0x80 | 8)
				e.WriteVarUint(it.origin[0])
				e.WriteVarUint(it.origin[1])
			} else if it.parent != nil {
				e.WriteUint8(0x20 | 8)
				e.WriteVarUint(0)
				e.WriteVarUint(it.parent[0])
				e.WriteVarUint(it.parent[1])
				e.WriteVarString("k")
			} else {
				e.WriteUint8(0x20 | 8)
				e.WriteVarUint(1)
				e.WriteVarString(meta.CommentsKey)
				e.WriteVarString("k")
			}
			e.WriteVarUint(1)
			e.WriteUint8(125) // a varint
			e.WriteVarInt(1)
		}
	}
	e.WriteVarUint(0) // no deletions
	return e.Bytes()
}

func TestCheckUpdateRefusesWhatCommentsDoNotHold(t *testing.T) {
	for name, edit := range map[string]func(*crdt.Doc){
		"text": func(d *crdt.Doc) {
			text := d.GetText("t")
			d.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "x", nil) })
		},
		"array": func(d *crdt.Doc) {
			array := d.GetArray("a")
			d.Transact(func(txn *crdt.Transaction) { array.Push(txn, []any{1}) })
		},
		"a text in the comments": func(d *crdt.Doc) {
			comments := d.GetMap(meta.CommentsKey)
			d.Transact(func(txn *crdt.Transaction) { comments.Set(txn, "t", crdt.NewTextPrelim()) })
		},
	} {
		guest := crdt.New()
		edit(guest)
		if err := meta.CheckUpdate(crdt.New(), crdt.EncodeStateAsUpdateV1(guest, nil)); !errors.Is(err, meta.ErrRefused) {
			t.Fatalf("%s: CheckUpdate = %v", name, err)
		}
	}
}

func TestCheckUpdateTakesWhatTheHostLoaded(t *testing.T) {
	// A guest's update on top of the host's own comments, and the host's
	// whole state, as a new peer gets it.
	host := crdt.New()
	meta.Load(host, &meta.File{Path: "a.md", Comments: map[string]meta.Thread{
		"c1": {Anchor: meta.Anchor{Type: meta.AnchorNode, ID: "n1"}, Quote: "q", Messages: map[string]meta.Message{
			"m1": {Author: "Ada", Time: "2026-10-21T00:00:00Z", Body: "hi"},
		}},
	}}, nil)
	if err := meta.CheckUpdate(crdt.New(), crdt.EncodeStateAsUpdateV1(host, nil)); err != nil {
		t.Fatal(err)
	}
	guest := crdt.New()
	if err := crdt.ApplyUpdateV1(guest, crdt.EncodeStateAsUpdateV1(host, nil), nil); err != nil {
		t.Fatal(err)
	}
	updates := updatesOf(guest)
	thread := guest.GetMap(meta.CommentsKey)
	guest.Transact(func(txn *crdt.Transaction) { thread.Delete(txn, "c1") })
	setThread(guest, "c2", "two")
	for _, u := range *updates {
		if err := meta.CheckUpdate(host, u); err != nil {
			t.Fatal(err)
		}
		if err := crdt.ApplyUpdateV1(host, u, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTheMeasureIsTheBrowsers(t *testing.T) {
	// A doc Yjs made, with an UndoManager's run of values, a deleted thread,
	// integers, and concurrent sets of values and of maps, and its measure
	// there: ygo, which encodes it larger, measures
	// it alike.
	data, err := os.ReadFile("../../packages/testdata/meta-measure.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		State   []byte `json:"state"`
		Measure int    `json:"measure"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	if err := meta.CheckUpdate(doc, fixture.State); err != nil {
		t.Fatal(err)
	}
	if err := crdt.ApplyUpdateV1(doc, fixture.State, nil); err != nil {
		t.Fatal(err)
	}
	if got := meta.DocSize(doc); got != fixture.Measure {
		t.Fatalf("measured %d; Yjs measured %d", got, fixture.Measure)
	}
	if n := len(crdt.EncodeStateAsUpdateV1(doc, nil)); n > fixture.Measure {
		t.Fatalf("ygo encodes it in %d bytes, past its measure", n)
	}
}
