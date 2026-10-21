package meta_test

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
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
	if !errors.Is(err, meta.ErrRefused) || !strings.Contains(err.Error(), "skips") {
		t.Fatalf("CheckUpdate = %v", err)
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
