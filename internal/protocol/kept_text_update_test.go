package protocol

import (
	"testing"

	"github.com/reearth/ygo/encoding"
)

func keptUpdateFixture(ref byte, payload func(*encoding.Encoder)) []byte {
	e := encoding.NewEncoder()
	e.WriteVarUint(1)
	e.WriteVarUint(1)
	e.WriteVarUint(123)
	e.WriteVarUint(0)
	e.WriteUint8(ref)
	if ref != 0 && ref != 10 {
		e.WriteUint8(1)
		e.WriteVarString("content")
	}
	payload(e)
	e.WriteVarUint(0)
	return e.Bytes()
}
func TestValidateKeptTextUpdateContentReferences(t *testing.T) {
	fixtures := map[byte]func(*encoding.Encoder){
		0:  func(e *encoding.Encoder) { e.WriteVarUint(1) },
		1:  func(e *encoding.Encoder) { e.WriteVarUint(1) },
		2:  func(e *encoding.Encoder) { e.WriteVarUint(1); e.WriteVarString(`{"value":1}`) },
		3:  func(e *encoding.Encoder) { e.WriteVarBytes([]byte{1, 2}) },
		4:  func(e *encoding.Encoder) { e.WriteVarString("text") },
		5:  func(e *encoding.Encoder) { e.WriteVarString(`{"embed":true}`) },
		6:  func(e *encoding.Encoder) { e.WriteVarString("bold"); e.WriteVarString("true") },
		7:  func(e *encoding.Encoder) { e.WriteUint8(3); e.WriteVarString("paragraph") },
		8:  func(e *encoding.Encoder) { e.WriteVarUint(1); e.WriteAny(map[string]any{"x": []any{"nested"}}) },
		9:  func(e *encoding.Encoder) { e.WriteVarBytes([]byte("subdocument")); e.WriteAny(map[string]any{}) },
		10: func(e *encoding.Encoder) { e.WriteVarUint(1) },
	}
	for ref, payload := range fixtures {
		update := keptUpdateFixture(ref, payload)
		if err := ValidateKeptTextUpdate(update); err != nil {
			t.Fatalf("ref%d: %v", ref, err)
		}
		for n := 0; n < len(update); n++ {
			if ValidateKeptTextUpdate(update[:n]) == nil {
				t.Fatalf("ref%d accepts truncated%d", ref, n)
			}
		}
		if ValidateKeptTextUpdate(append(update, 0)) == nil {
			t.Fatalf("ref%d accepts trailing data", ref)
		}
	}
}
func TestValidateKeptTextUpdateRejectsUnknownReference(t *testing.T) {
	if ValidateKeptTextUpdate(keptUpdateFixture(31, func(*encoding.Encoder) {})) == nil {
		t.Fatal("unknown reference accepted")
	}
}

func TestValidateKeptTextUpdateNestedParentID(t *testing.T) {
	e := encoding.NewEncoder()
	e.WriteVarUint(1)
	e.WriteVarUint(2)
	e.WriteVarUint(123)
	e.WriteVarUint(0)
	e.WriteUint8(7)
	e.WriteUint8(1)
	e.WriteVarString("content")
	e.WriteUint8(2) // nested Y.Text
	e.WriteUint8(4)
	e.WriteUint8(0)
	e.WriteVarUint(123)
	e.WriteVarUint(0)
	e.WriteVarString("nested text")
	e.WriteVarUint(0)
	if err := ValidateKeptTextUpdate(e.Bytes()); err != nil {
		t.Fatal(err)
	}
}
