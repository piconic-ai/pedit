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
