package meta

import (
	"strings"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
)

func TestTrackerDoesNotAskAgainForWhatItCannotPlace(t *testing.T) {
	content := crdt.New()
	text := content.GetText(ContentText)
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "abc", nil) })
	tr := NewTracker(content)
	defer tr.Close()
	gone := encodePosition(crdt.CreateRelativePositionFromIndex(text, 1, 0))
	content.Transact(func(txn *crdt.Transaction) { text.Delete(txn, 1, 1) })
	unknown := encodePosition(crdt.RelativePosition{Item: &crdt.ID{Client: 7, Clock: 3}})

	tr.startTries()
	if _, ok := tr.resolve(gone); ok {
		t.Fatal("placed a deleted character")
	}
	if _, ok := tr.resolve(unknown); ok {
		t.Fatal("placed a character not received")
	}
	if !tr.gone[gone] || tr.unknown[unknown] != tr.gen {
		t.Fatalf("gone %v unknown %v", tr.gone, tr.unknown)
	}
	// Neither costs a try again; the unknown one does once the text changes.
	tries := tr.tries
	tr.resolve(gone)
	tr.resolve(unknown)
	if tr.tries != tries {
		t.Fatalf("tries %d, then %d", tries, tr.tries)
	}
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "x", nil) })
	tr.resolve(unknown)
	if tr.tries != tries-1 {
		t.Fatalf("did not ask again after the text changed: %d", tr.tries)
	}
	// Forgotten with their anchors.
	tr.keep(map[string]bool{})
	if len(tr.gone)+len(tr.unknown) != 0 {
		t.Fatalf("kept %v %v", tr.gone, tr.unknown)
	}
}

func TestTrackerTriesABoundedNumberOfPositions(t *testing.T) {
	content := crdt.New()
	text := content.GetText(ContentText)
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, strings.Repeat("a", 2*maxTries), nil) })
	tr := NewTracker(content)
	defer tr.Close()
	tr.startTries()
	placed := 0
	for i := range 2 * maxTries {
		if _, ok := tr.resolve(encodePosition(crdt.CreateRelativePositionFromIndex(text, i, 0))); ok {
			placed++
		}
	}
	if placed != maxTries {
		t.Fatalf("placed %d", placed)
	}
}

func TestFindIgnoresMatchesOffTheCharacters(t *testing.T) {
	// From review: U+0102 repeated holds the bytes of U+0201 at every odd
	// offset of UTF-16, and nowhere on a character.
	content := strings.Repeat("Ă", 1<<19)
	h := newHaystack(content)
	units := []uint16{}
	for range 1 << 19 {
		units = append(units, 0x0102)
	}
	start := time.Now()
	for range 100 {
		if a, _ := find(&Selector{Exact: "ȁ"}, units, h); a != -1 {
			t.Fatalf("found at %d", a)
		}
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("took %v", d)
	}
}
