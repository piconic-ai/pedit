package session

import (
	"encoding/json"
	"testing"
)

func TestObserverEvidenceCannotReplaceObservedHistory(t *testing.T) {
	encode := func(e recoveryEvidence) []byte {
		b, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	old := recoveryEvidence{Tail: 1, Entries: []evidenceEntry{{Sequence: 1, Ciphertext: []byte("a")}}}
	cases := []struct {
		name string
		next recoveryEvidence
		ok   bool
	}{
		{"identical", old, true},
		{"append", recoveryEvidence{Tail: 2, Entries: []evidenceEntry{{Sequence: 1, Ciphertext: []byte("a")}, {Sequence: 2, Ciphertext: []byte("b")}}}, true},
		{"same tail changed", recoveryEvidence{Tail: 1, Entries: []evidenceEntry{{Sequence: 1, Ciphertext: []byte("b")}}}, false},
		{"new tail rewrites old", recoveryEvidence{Tail: 2, Entries: []evidenceEntry{{Sequence: 1, Ciphertext: []byte("b")}, {Sequence: 2, Ciphertext: []byte("c")}}}, false},
		{"new tail omits old", recoveryEvidence{Tail: 2, Entries: []evidenceEntry{{Sequence: 2, Ciphertext: []byte("c")}}}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := extendsObserverEvidence(encode(old), encode(c.next))
			if (err == nil) != c.ok {
				t.Fatalf("result %v", err)
			}
		})
	}
}
