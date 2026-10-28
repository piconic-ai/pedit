package protocol

import (
	"testing"

	"github.com/reearth/ygo/crdt"
)

func TestKeptTextStateRejectsNoncanonicalVarints(t *testing.T) {
	valid := []byte{1, 1, 1, 0, 4, 1, 7, 'c', 'o', 'n', 't', 'e', 'n', 't', 1, 'a', 0}
	if err := CheckKeptTextState(valid); err != nil {
		t.Fatal(err)
	}
	for _, at := range []int{0, 1, 2, 3, 5, 6, 14, 16} {
		bad := append([]byte(nil), valid[:at]...)
		bad = append(bad, valid[at]|0x80, 0)
		bad = append(bad, valid[at+1:]...)
		if err := CheckKeptTextState(bad); err == nil {
			t.Errorf("accepted overlong varint at %d", at)
		}
	}
	if err := CheckKeptTextState([]byte{0x80, 0, 0}); err == nil {
		t.Fatal("accepted noncanonical empty state")
	}
	gc := []byte{1, 1, 1, 0, 0, 1, 0}
	if err := crdt.ApplyUpdateV1(crdt.New(), gc, nil); err != nil {
		t.Fatalf("valid GC fixture: %v", err)
	}
	if err := CheckKeptTextState(gc); err == nil {
		t.Fatal("accepted GC without root information")
	}
	withBOM := []byte{1, 1, 1, 0, 4, 1, 10, 0xef, 0xbb, 0xbf, 'c', 'o', 'n', 't', 'e', 'n', 't', 1, 'a', 0}
	if err := CheckKeptTextState(withBOM); err == nil {
		t.Fatal("accepted a root prefixed by BOM")
	}
}

func TestKeptTextStateRejectsUnknownRootsAndTypes(t *testing.T) {
	text := crdt.New()
	value := text.GetText("content")
	text.Transact(func(tx *crdt.Transaction) { value.Insert(tx, 0, "base", nil) })
	text.Transact(func(tx *crdt.Transaction) { value.Insert(tx, 4, " guest", nil) })
	if err := CheckKeptTextState(crdt.EncodeStateAsUpdateV1(text, nil)); err != nil {
		t.Fatalf("plain text: %v", err)
	}
	other := text.GetText("other")
	text.Transact(func(tx *crdt.Transaction) { other.Insert(tx, 0, "hidden", nil) })
	if err := CheckKeptTextState(crdt.EncodeStateAsUpdateV1(text, nil)); err == nil {
		t.Fatal("accepted unknown root alongside content")
	}
	mapDoc := crdt.New()
	m := mapDoc.GetMap("content")
	mapDoc.Transact(func(tx *crdt.Transaction) { m.Set(tx, "key", "value") })
	if err := CheckKeptTextState(crdt.EncodeStateAsUpdateV1(mapDoc, nil)); err == nil {
		t.Fatal("accepted map content")
	}
	if err := CheckKeptTextState(append(crdt.EncodeStateAsUpdateV1(crdt.New(), nil), 0)); err == nil {
		t.Fatal("accepted trailing bytes")
	}
}

func TestKeptTextStateAcceptsDeletedText(t *testing.T) {
	doc := crdt.New()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "deleted", nil) })
	doc.Transact(func(tx *crdt.Transaction) { text.Delete(tx, 0, 7) })
	if err := CheckKeptTextState(crdt.EncodeStateAsUpdateV1(doc, nil)); err != nil {
		t.Fatalf("deleted plain text: %v", err)
	}
}
