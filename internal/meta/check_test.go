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

func TestCheckUpdateRefusesManyItemsInOnePlace(t *testing.T) {
	// From review: Yjs and ygo take time in the square of the items set at
	// once in one place; 24,000 of them took 31s to apply.
	if err := meta.CheckUpdate(crdt.New(), concurrentSets(t, meta.MaxPlaceItems)); err != nil {
		t.Fatalf("refused %d: %v", meta.MaxPlaceItems, err)
	}
	err := meta.CheckUpdate(crdt.New(), concurrentSets(t, meta.MaxPlaceItems+1))
	if !errors.Is(err, meta.ErrRefused) || !strings.Contains(err.Error(), "one place") {
		t.Fatalf("CheckUpdate = %v", err)
	}
	// Nor a few at a time.
	host := crdt.New()
	if err := crdt.ApplyUpdateV1(host, concurrentSets(t, meta.MaxPlaceItems), nil); err != nil {
		t.Fatal(err)
	}
	if err := meta.CheckUpdate(host, concurrentSets(t, 1)); !errors.Is(err, meta.ErrRefused) {
		t.Fatalf("CheckUpdate = %v", err)
	}
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
