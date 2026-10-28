package protocol

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
)

func TestKeptLedgerVectors(t *testing.T) {
	raw, err := os.ReadFile("../../packages/testdata/kept-ledger-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Limit   int
		Vectors []struct {
			Access, Sender, Message, Decision, Digest string
			Sequence                                  uint64
			Commit                                    *string
		}
	}
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	ledger, err := NewKeptLedger(v.Limit)
	if err != nil {
		t.Fatal(err)
	}
	for i, item := range v.Vectors {
		var access Access
		switch item.Access {
		case "edit":
			access = AccessEdit
		case "comment":
			access = AccessComment
		default:
			t.Fatal("invalid vector access")
		}
		sender, err := hex.DecodeString(item.Sender)
		if err != nil {
			t.Fatal(err)
		}
		var id [32]byte
		copy(id[:], sender)
		rec := KeptRecord{Access: access, Sender: id, Sequence: item.Sequence, Message: []byte(item.Message)}
		plan, err := ledger.Inspect(rec)
		if err != nil || string(plan.Decision) != item.Decision || hex.EncodeToString(plan.Digest[:]) != item.Digest {
			t.Fatalf("vector %d: %+v %v", i, plan, err)
		}
		if item.Commit != nil {
			old := ledger
			ledger, err = ledger.Commit(plan, KeptOutcome(*item.Commit))
			if err != nil {
				t.Fatal(err)
			}
			if _, err = ledger.Commit(plan, KeptApplied); err == nil {
				t.Fatal("accepted stale plan")
			}
			repeat, err := old.Inspect(rec)
			if err != nil || repeat.Decision != KeptNext {
				t.Fatal("commit mutated original ledger")
			}
		}
		snapshot := ledger.Snapshot()
		restored, err := RestoreKeptLedger(v.Limit, snapshot)
		if err != nil {
			t.Fatal(err)
		}
		observed, err := restored.Inspect(rec)
		if err != nil {
			t.Fatal(err)
		}
		if item.Commit != nil && observed.Decision != KeptDuplicate {
			t.Fatal("restored ledger lost receipt")
		}
		if len(snapshot) > 0 {
			snapshot[0].Sequence = 2
			if _, err := RestoreKeptLedger(v.Limit, snapshot); err == nil {
				t.Fatal("accepted snapshot with gap")
			}
			again, err := restored.Inspect(rec)
			if err != nil || again.Decision != observed.Decision {
				t.Fatal("snapshot mutation changed ledger")
			}
		}
		if i == 8 && plan.Outcome != KeptRejected {
			t.Fatal("rejected outcome was lost")
		}
	}
}

func TestKeptLedgerInvalidInputs(t *testing.T) {
	if _, err := NewKeptLedger(0); err == nil {
		t.Fatal("accepted zero limit")
	}
	ledger, _ := NewKeptLedger(1)
	for _, r := range []KeptRecord{{Access: AccessRead, Sequence: 1, Message: []byte("a")}, {Access: AccessEdit, Sequence: 0, Message: []byte("a")}, {Access: AccessEdit, Sequence: maxKeptCounter + 1, Message: []byte("a")}, {Access: AccessEdit, Sequence: 1}} {
		if _, err := ledger.Inspect(r); err == nil {
			t.Fatal("accepted invalid record")
		}
	}
	r := KeptRecord{Access: AccessEdit, Sequence: 1, Message: []byte("a")}
	plan, _ := ledger.Inspect(r)
	if _, err := ledger.Commit(plan, "invalid"); err == nil {
		t.Fatal("accepted invalid outcome")
	}
	gap, _ := ledger.Inspect(KeptRecord{Access: AccessEdit, Sequence: 2, Message: []byte("a")})
	gap.Decision = KeptNext
	gap.Floor = 1
	if _, err := ledger.Commit(gap, KeptApplied); err == nil {
		t.Fatal("accepted modified gap plan")
	}
	plan.Digest[0] ^= 1
	if _, err := ledger.Commit(plan, KeptApplied); err == nil {
		t.Fatal("accepted modified plan")
	}
}
