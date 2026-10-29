package protocol

import (
	"bytes"
	"testing"

	"github.com/reearth/ygo/crdt"
)

func TestKeptIncrementalSchema(t *testing.T) {
	text := crdt.New()
	defer text.Destroy()
	value := text.GetText("content")
	text.Transact(func(tx *crdt.Transaction) { value.Insert(tx, 0, "base", nil) })
	var update []byte
	text.OnUpdate(func(b []byte, _ any) { update = bytes.Clone(b) })
	text.Transact(func(tx *crdt.Transaction) { value.Insert(tx, 4, " guest", nil) })
	if CheckKeptTextState(update) == nil || CheckKeptTextUpdate(update) != nil {
		t.Fatal("incremental text not distinguished from snapshot")
	}
	if CheckKeptTextUpdate(append(bytes.Clone(update), 0xff)) == nil {
		t.Fatal("accepted trailing text bytes")
	}
	comments := crdt.New()
	defer comments.Destroy()
	root := comments.GetMap("comments")
	var thread *crdt.YMap
	comments.Transact(func(tx *crdt.Transaction) {
		thread = crdt.NewMapPrelim()
		root.Set(tx, "c1", thread)
		thread.Set(tx, "quote", "old")
	})
	var commentUpdate []byte
	comments.OnUpdate(func(b []byte, _ any) { commentUpdate = bytes.Clone(b) })
	comments.Transact(func(tx *crdt.Transaction) { thread.Set(tx, "quote", "new") })
	if CheckKeptCommentsState(commentUpdate) == nil || CheckKeptCommentsUpdate(commentUpdate) != nil {
		t.Fatal("incremental comments not distinguished from snapshot")
	}
	if CheckKeptCommentsUpdate(append(bytes.Clone(commentUpdate), 0xff)) == nil {
		t.Fatal("accepted trailing comments bytes")
	}
}
