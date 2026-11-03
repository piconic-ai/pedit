package meta_test

import (
	"reflect"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

// nodeThread adds a thread on a canvas node, as a browser does.
func nodeThread(m *crdt.Doc, id, node, quote string, messages map[string]any) {
	comments := m.GetMap(meta.CommentsKey)
	m.Transact(func(txn *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		comments.Set(txn, id, thread)
		thread.Set(txn, meta.AnchorKey, map[string]any{"type": meta.AnchorNode, "id": node})
		thread.Set(txn, meta.QuoteKey, quote)
		thread.Set(txn, meta.ResolvedKey, false)
		ms := crdt.NewMapPrelim()
		thread.Set(txn, meta.MessagesKey, ms)
		for k, v := range messages {
			ms.Set(txn, k, v)
		}
	})
}

func message(author, time, body string) map[string]any {
	return map[string]any{"author": author, "time": time, "body": body}
}

func threadMap(m *crdt.Doc, id string) *crdt.YMap {
	v, _ := m.GetMap(meta.CommentsKey).Get(id)
	return v.(*crdt.YMap)
}

func messagesOf(m *crdt.Doc, id string) *crdt.YMap {
	v, _ := threadMap(m, id).Get(meta.MessagesKey)
	return v.(*crdt.YMap)
}

func TestShownThreadsReadsAsTheBrowserShows(t *testing.T) {
	m := crdt.New()
	nodeThread(m, "t2", "n‮1", "Ideas\x1b[31m", map[string]any{
		"b": message("Bo⁦", "2026-10-21T00:00:02Z", "second\nline\x07"),
		"a": message("", "2026-10-21T00:00:01Z", "first"),
		// Not shown: an invalid time, an invalid id.
		"c":   message("Cy", "2026-13-01T00:00:00Z", "bad month"),
		"d d": message("Di", "2026-10-21T00:00:03Z", "bad id"),
	})
	nodeThread(m, "t1", "n0", "Older", map[string]any{"x": message("Ada", "2026-10-20T00:00:00Z", "older")})
	// Not shown: an anchor of no kind the host saves.
	comments := m.GetMap(meta.CommentsKey)
	m.Transact(func(txn *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		comments.Set(txn, "t3", thread)
		thread.Set(txn, meta.AnchorKey, map[string]any{"type": "edge"})
		thread.Set(txn, meta.QuoteKey, "x")
	})

	got := meta.ShownThreads(m)
	want := []meta.Shown{
		{ID: "t1", Kind: meta.AnchorNode, Node: "n0", Quote: "Older", Messages: []meta.ShownMessage{
			{ID: "x", Author: "Ada", Time: "2026-10-20T00:00:00Z", Body: "older"},
		}},
		{ID: "t2", Kind: meta.AnchorNode, Node: "n1", Quote: "Ideas[31m", Messages: []meta.ShownMessage{
			{ID: "a", Author: "anonymous", Time: "2026-10-21T00:00:01Z", Body: "first"},
			{ID: "b", Author: "Bo", Time: "2026-10-21T00:00:02Z", Body: "second\nline"},
		}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
}

func TestDiffTellsWhatChanged(t *testing.T) {
	m := crdt.New()
	nodeThread(m, "t1", "n1", "Ideas", map[string]any{"a": message("Ada", "2026-10-21T00:00:01Z", "first")})
	nodeThread(m, "t2", "n2", "Plan", map[string]any{"p": message("Ada", "2026-10-21T00:00:01Z", "plan")})
	before := meta.ShownThreads(m)

	nodeThread(m, "t3", "n3", "New", map[string]any{"n": message("Bo", "2026-10-21T00:00:05Z", "new thread")})
	t1, ms, comments := threadMap(m, "t1"), messagesOf(m, "t1"), m.GetMap(meta.CommentsKey)
	m.Transact(func(txn *crdt.Transaction) {
		ms.Set(txn, "b", message("Bo", "2026-10-21T00:00:02Z", "reply"))
		ms.Set(txn, "a", message("Ada", "2026-10-21T00:00:01Z", "first, edited"))
		t1.Set(txn, meta.ResolvedKey, true)
		comments.Delete(txn, "t2")
	})
	after := meta.ShownThreads(m)

	var got []string
	for _, c := range meta.Diff(before, after) {
		got = append(got, c.Kind+" "+c.Thread.ID+" "+c.Message.ID+" "+c.Message.Body+map[bool]string{true: " new"}[c.NewThread])
	}
	want := []string{
		"edited t1 a first, edited",
		"comment t1 b reply",
		"resolved t1  ",
		"comment t3 n new thread new",
		"deleted t2  ",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}

	m.Transact(func(txn *crdt.Transaction) {
		t1.Set(txn, meta.ResolvedKey, false)
		ms.Delete(txn, "b")
	})
	got = nil
	for _, c := range meta.Diff(after, meta.ShownThreads(m)) {
		got = append(got, c.Kind+" "+c.Thread.ID+" "+c.Message.ID)
	}
	want = []string{"deleted t1 b", "reopened t1 "}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
}

func TestCleanKeepsLinesOnlyWhenAsked(t *testing.T) {
	if got := meta.Clean("a\tb\nc\x00‏", true); got != "a\tb\nc" {
		t.Fatalf("%q", got)
	}
	if got := meta.Clean("a\tb\nc", false); got != "abc" {
		t.Fatalf("%q", got)
	}
}

func TestCutUnitsCountsAsJavaScriptDoes(t *testing.T) {
	if got := meta.CutUnits("ab😀c", 3); got != "ab" {
		t.Fatalf("%q", got)
	}
	if got := meta.CutUnits("ab😀c", 4); got != "ab😀" {
		t.Fatalf("%q", got)
	}
}
