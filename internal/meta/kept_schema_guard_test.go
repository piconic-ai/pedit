package meta_test

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

func TestAcceptedKeptCommentsRespectMetaGuard(t *testing.T) {
	for _, name := range []string{"kept-schema-mutations.json", "kept-schema-generated-mutations.json"} {
		data, err := os.ReadFile("../../packages/testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		var vectors []struct {
			Name, Kind, Hex string
			Valid           bool
		}
		if err = json.Unmarshal(data, &vectors); err != nil {
			t.Fatal(err)
		}
		for _, v := range vectors {
			if v.Kind != "comments" || !v.Valid {
				continue
			}
			raw, err := hex.DecodeString(v.Hex)
			if err != nil {
				t.Fatal(err)
			}
			if protocol.CheckKeptCommentsState(raw) != nil {
				t.Fatalf("schema rejected %s", v.Name)
			}
			probe := crdt.New()
			if err = crdt.ApplyUpdateV1(probe, raw, nil); err != nil {
				probe.Destroy()
				continue
			}
			pending := probe.PendingStats()
			probe.Destroy()
			if pending.Items != 0 || pending.DeleteRanges != 0 {
				continue
			}
			fresh := crdt.New()
			err = meta.CheckUpdate(fresh, raw)
			fresh.Destroy()
			if err != nil {
				t.Errorf("%s: meta guard rejects complete accepted state: %v", v.Name, err)
			}
		}
	}
}

func TestKeptCommentsResourceBoundRespectsMetaGuard(t *testing.T) {
	for _, size := range []int{0, 1_044_000} {
		doc := crdt.New()
		m := doc.GetMap("comments")
		doc.Transact(func(tx *crdt.Transaction) {
			if size > 0 {
				m.Set(tx, "large", strings.Repeat("x", size))
			} else {
				for i := 0; i < 1024; i++ {
					m.Set(tx, fmt.Sprintf("k%d", i), i)
				}
			}
		})
		state := crdt.EncodeStateAsUpdateV1(doc, nil)
		doc.Destroy()
		if err := protocol.CheckKeptCommentsState(state); err != nil {
			t.Fatal(err)
		}
		fresh := crdt.New()
		err := meta.CheckUpdate(fresh, state)
		fresh.Destroy()
		if err != nil {
			t.Fatalf("accepted boundary exceeds meta guard: %v", err)
		}
	}
}

func TestKeptCommentsOneLongListRespectsMetaGuard(t *testing.T) {
	doc := crdt.New()
	m := doc.GetMap("comments")
	for i := 0; i < 1024; i++ {
		doc.Transact(func(tx *crdt.Transaction) { m.Set(tx, "same", i) })
	}
	state := crdt.EncodeStateAsUpdateV1(doc, nil)
	doc.Destroy()
	if err := protocol.CheckKeptCommentsState(state); err != nil {
		t.Fatal(err)
	}
	fresh := crdt.New()
	err := meta.CheckUpdate(fresh, state)
	fresh.Destroy()
	if err != nil {
		t.Fatal(err)
	}
}
