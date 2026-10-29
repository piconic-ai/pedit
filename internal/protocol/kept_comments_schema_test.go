package protocol

import (
	"bytes"
	"fmt"
	"github.com/reearth/ygo/crdt"
	"strings"
	"testing"
)

func TestKeptCommentsSchema(t *testing.T) {
	value, err := DecodeKeptTextPayload(textVectorBytes(t, loadTextVector(t).Payload), 4)
	if err != nil {
		t.Fatal(err)
	}
	valid := value.Documents[7]
	if err = CheckKeptCommentsState(valid); err != nil {
		t.Fatalf("valid comments: %v", err)
	}
	doc := crdt.New()
	m := doc.GetMap("unknown")
	doc.Transact(func(tx *crdt.Transaction) { m.Set(tx, "c", "value") })
	alien := crdt.EncodeStateAsUpdateV1(doc, nil)
	for _, input := range [][]byte{alien, append(append([]byte{}, valid...), 0), {0x80, 0, 0}} {
		if CheckKeptCommentsState(input) == nil {
			t.Fatalf("accepted %x", input)
		}
		value.Documents[7] = input
		if _, err = EncodeKeptTextPayload(value); err == nil {
			t.Fatalf("payload accepted %x", input)
		}
	}
}

func TestKeptCommentsSchemaRejectsBOMAndInvalidUTF8(t *testing.T) {
	d := crdt.New()
	m := d.GetMap("\ufeffcomments")
	d.Transact(func(tx *crdt.Transaction) { m.Set(tx, "c", "value") })
	if CheckKeptCommentsState(crdt.EncodeStateAsUpdateV1(d, nil)) == nil {
		t.Fatal("accepted BOM root")
	}
	d = crdt.New()
	m = d.GetMap("comments")
	d.Transact(func(tx *crdt.Transaction) { m.Set(tx, "c", "UniqueValue") })
	b := crdt.EncodeStateAsUpdateV1(d, nil)
	i := bytes.Index(b, []byte("UniqueValue"))
	if i < 0 {
		t.Fatal("value absent")
	}
	b[i] = 0xff
	if CheckKeptCommentsState(b) == nil {
		t.Fatal("accepted invalid UTF-8")
	}
}

func TestKeptCommentsConservativeResourceBound(t *testing.T) {
	for _, n := range []int{1024, 1025} {
		doc := crdt.New()
		m := doc.GetMap("comments")
		doc.Transact(func(tx *crdt.Transaction) {
			for i := 0; i < n; i++ {
				m.Set(tx, fmt.Sprintf("k%d", i), i)
			}
		})
		state := crdt.EncodeStateAsUpdateV1(doc, nil)
		doc.Destroy()
		if got := CheckKeptCommentsState(state) == nil; got != (n == 1024) {
			t.Fatalf("%d clocks accepted=%v", n, got)
		}
	}
	for _, size := range []int{1_044_000, 1_044_400} {
		doc := crdt.New()
		m := doc.GetMap("comments")
		doc.Transact(func(tx *crdt.Transaction) { m.Set(tx, "k", strings.Repeat("x", size)) })
		state := crdt.EncodeStateAsUpdateV1(doc, nil)
		doc.Destroy()
		if got := CheckKeptCommentsState(state) == nil; got != (size == 1_044_000) {
			t.Fatalf("size %d accepted=%v", size, got)
		}
	}
}
