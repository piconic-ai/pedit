package meta_test

import (
	"encoding/json"
	"errors"
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
	}
	if err := json.Unmarshal(data, &limits); err != nil {
		t.Fatal(err)
	}
	if limits.MaxDocBytes != meta.MaxDocBytes || limits.MaxClientClock != meta.MaxClientClock {
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
	if err := meta.CheckUpdate(crdt.New(), concurrentSets(t, meta.MaxListItems)); err != nil {
		t.Fatalf("refused %d: %v", meta.MaxListItems, err)
	}
	err := meta.CheckUpdate(crdt.New(), concurrentSets(t, meta.MaxListItems+1))
	if !errors.Is(err, meta.ErrRefused) || !strings.Contains(err.Error(), "list") {
		t.Fatalf("CheckUpdate = %v", err)
	}
	// Nor a few at a time.
	host := crdt.New()
	if err := crdt.ApplyUpdateV1(host, concurrentSets(t, meta.MaxListItems), nil); err != nil {
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
	n := meta.MaxListItems
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
	if !errors.Is(err, meta.ErrRefused) || !strings.Contains(err.Error(), "list") {
		t.Fatalf("CheckUpdate = %v", err)
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

type item struct{ origin *[2]uint64 }

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
