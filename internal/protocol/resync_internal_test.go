package protocol

import (
	"errors"
	"testing"

	"github.com/reearth/ygo/awareness"
	"github.com/reearth/ygo/crdt"
	ysync "github.com/reearth/ygo/sync"
)

func TestDestroyedClientDoesNotScheduleResyncForAnInFlightUpdate(t *testing.T) {
	doc := crdt.New()
	defer doc.Destroy()
	key, err := DecodeKey(GenerateKey())
	if err != nil {
		t.Fatal(err)
	}
	c, err := NewClient(ClientOptions{Key: key, Doc: doc, Awareness: awareness.New(uint64(doc.ClientID()))})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Destroy()
	checked := crdt.New()
	defer checked.Destroy()
	if err := c.AddCheckedFile(1, checked, func(*crdt.Doc, []byte) error { return ErrRetryLater }); err != nil {
		t.Fatal(err)
	}
	update := ysync.EncodeUpdate(crdt.EncodeStateAsUpdateV1(doc, nil))
	if err := c.receiveFileSync(1, AccessEdit, Sender{1}, update); !errors.Is(err, ErrRetryLater) {
		t.Fatalf("first update = %v", err)
	}
	c.Destroy()
	if err := c.receiveFileSync(1, AccessEdit, Sender{1}, update); !errors.Is(err, ErrRetryLater) {
		t.Fatalf("in-flight update = %v", err)
	}
	if n := c.PendingResyncs(); n != 0 {
		t.Fatalf("%d resync timers scheduled after Destroy", n)
	}
}
