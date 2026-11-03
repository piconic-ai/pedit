package meta_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

const at = "2026-10-22T00:00:00.000Z"

func apply(t *testing.T, doc *crdt.Doc, update []byte, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	if update == nil {
		t.Fatal("no update")
	}
	if err := crdt.ApplyUpdateV1(doc, update, nil); err != nil {
		t.Fatal(err)
	}
}

func TestAReplyIsWrittenAsTheBrowserWritesOne(t *testing.T) {
	m := crdt.New()
	nodeThread(m, "t1", "n1", "Ideas", map[string]any{"a": message("Ada", "2026-10-21T00:00:01Z", "first")})
	state := string(crdt.EncodeStateAsUpdateV1(m, nil))
	u, err := meta.ReplyUpdate(m, "t1", "r1", "tate‮-pm", at, "A reply\nwith lines")
	if string(crdt.EncodeStateAsUpdateV1(m, nil)) != state {
		t.Fatal("the doc changed before the update was applied")
	}
	apply(t, m, u, err)
	if err := meta.CheckUpdate(crdt.New(), crdt.EncodeStateAsUpdateV1(m, nil)); err != nil {
		t.Fatalf("a peer starting afresh refuses the doc: %v", err)
	}
	th := meta.ShownThreads(m)[0]
	if len(th.Messages) != 2 || th.Messages[1] != (meta.ShownMessage{ID: "r1", Author: "tate-pm", Time: at, Body: "A reply\nwith lines"}) {
		t.Fatalf("%+v", th.Messages)
	}
	// Sent again, it is written once; another comment under its id is refused.
	if u, err := meta.ReplyUpdate(m, "t1", "r1", "tate-pm", at, "A reply\nwith lines"); u != nil || err != nil {
		t.Fatalf("again: %v %v", u, err)
	}
	if _, err := meta.ReplyUpdate(m, "t1", "r1", "tate-pm", at, "Another"); !errors.Is(err, meta.ErrIDTaken) {
		t.Fatal(err)
	}
	if _, err := meta.ReplyUpdate(m, "t1", "a", "Bo", at, "first"); !errors.Is(err, meta.ErrIDTaken) {
		t.Fatalf("someone else's id: %v", err)
	}
}

func TestAReplyBreakingARuleIsRefused(t *testing.T) {
	m := crdt.New()
	nodeThread(m, "t1", "n1", "Ideas", map[string]any{})
	for _, tc := range []struct {
		thread, id, time, body string
		want                   error
	}{
		{"nope", "r1", at, "hi", meta.ErrNoThread},
		{"t1", "bad id", at, "hi", meta.ErrInvalidID},
		{"t1", "r1", at, " \n", meta.ErrEmptyBody},
		{"t1", "r1", at, strings.Repeat("x", meta.MaxBody+1), meta.ErrBodyTooLong},
		{"t1", "r1", "yesterday", "hi", nil},
	} {
		_, err := meta.ReplyUpdate(m, tc.thread, tc.id, "Ada", tc.time, tc.body)
		if err == nil || tc.want != nil && !errors.Is(err, tc.want) {
			t.Fatalf("%+v: %v", tc, err)
		}
	}
	many := map[string]any{}
	for i := range meta.MaxMessages {
		many[strings.Repeat("m", 1)+string(rune('A'+i%26))+strings.Repeat("x", i/26)] = message("Ada", at, "x")
	}
	nodeThread(m, "t2", "n2", "Full", many)
	if _, err := meta.ReplyUpdate(m, "t2", "r1", "Ada", at, "one more"); !errors.Is(err, meta.ErrThreadFull) {
		t.Fatal(err)
	}
}

func TestResolvingAndReopening(t *testing.T) {
	m := crdt.New()
	nodeThread(m, "t1", "n1", "Ideas", map[string]any{"a": message("Ada", at, "first")})
	if u, err := meta.ResolveUpdate(m, "t1", false); u != nil || err != nil {
		t.Fatalf("reopening an open thread: %v %v", u, err)
	}
	u, err := meta.ResolveUpdate(m, "t1", true)
	apply(t, m, u, err)
	if !meta.ShownThreads(m)[0].Resolved {
		t.Fatal("not resolved")
	}
	u, err = meta.ResolveUpdate(m, "t1", false)
	apply(t, m, u, err)
	if meta.ShownThreads(m)[0].Resolved {
		t.Fatal("not reopened")
	}
	if _, err := meta.ResolveUpdate(m, "t9", true); !errors.Is(err, meta.ErrNoThread) {
		t.Fatal(err)
	}
}
