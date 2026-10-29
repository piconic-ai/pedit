package meta_test

import (
	"bytes"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

func TestRenderRecoveryStrict(t *testing.T) {
	doc, text := content("hello world")
	comments := crdt.New()
	guestThread(t, comments, text, "g1", map[string]any{"type": "text", "start": pos(text, 6, 0), "end": pos(text, 11, -1)}, "world")
	v, _ := comments.GetMap(meta.CommentsKey).Get("g1")
	comments.Transact(func(tx *crdt.Transaction) { v.(*crdt.YMap).Set(tx, "resolved", false) })
	prev, err := meta.Parse([]byte(`{"version":1,"path":"a.md","comments":{},"future":{"x":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	tracker := meta.NewTracker(doc)
	defer tracker.Close()
	raw, err := meta.RenderRecovery(comments, prev, tracker)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"future": {"x":1}`)) {
		t.Fatalf("unknown field lost: %s", raw)
	}
	parsed, err := meta.Parse(raw)
	if err != nil || parsed.Comments["g1"].Anchor.Text.Exact != "world" || len(parsed.Comments["g1"].Messages) != 1 {
		t.Fatal("comment lost", err)
	}
	if len(prev.Comments) != 0 {
		t.Fatal("baseline mutated")
	}
	doc.Transact(func(tx *crdt.Transaction) { text.Delete(tx, 6, 5) })
	fresh := meta.NewTracker(doc)
	defer fresh.Close()
	if _, err := meta.RenderRecovery(comments, prev, fresh); err == nil {
		t.Fatal("accepted deleted anchor")
	}
}

func TestRenderRecoveryRejectsUnknownThread(t *testing.T) {
	doc, text := content("hello")
	comments := crdt.New()
	guestThread(t, comments, text, "g1", map[string]any{"type": "text", "start": pos(text, 0, 0), "end": pos(text, 5, -1)}, "hello")
	value, _ := comments.GetMap(meta.CommentsKey).Get("g1")
	comments.Transact(func(tx *crdt.Transaction) { value.(*crdt.YMap).Set(tx, "unknown", true) })
	tracker := meta.NewTracker(doc)
	defer tracker.Close()
	if _, err := meta.RenderRecovery(comments, &meta.File{Path: "a.md"}, tracker); err == nil {
		t.Fatal("accepted unknown field")
	}
}

func TestRenderRecoveryRejectsInvalidMessageWithoutDroppingThread(t *testing.T) {
	doc, text := content("hello")
	comments := crdt.New()
	guestThread(t, comments, text, "g1", map[string]any{"type": "text", "start": pos(text, 0, 0), "end": pos(text, 5, -1)}, "hello")
	v, _ := comments.GetMap(meta.CommentsKey).Get("g1")
	thread := v.(*crdt.YMap)
	messages, _ := thread.Get(meta.MessagesKey)
	comments.Transact(func(tx *crdt.Transaction) {
		thread.Set(tx, "resolved", false)
		messages.(*crdt.YMap).Set(tx, "bad", map[string]any{"author": "A", "time": "invalid", "body": "message"})
	})
	tracker := meta.NewTracker(doc)
	defer tracker.Close()
	if _, err := meta.RenderRecovery(comments, &meta.File{Path: "a.md"}, tracker); err == nil {
		t.Fatal("accepted invalid message")
	}
}
