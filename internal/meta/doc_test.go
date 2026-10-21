package meta_test

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

// content is a text file's doc, as the host shares it.
func content(s string) (*crdt.Doc, *crdt.YText) {
	doc := crdt.New()
	text := doc.GetText(meta.ContentText)
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, s, nil) })
	return doc, text
}

func textThread(exact, prefix, suffix string, offset int) meta.Thread {
	return meta.Thread{
		Anchor: meta.Anchor{Type: meta.AnchorText, Text: &meta.Selector{Exact: exact, Prefix: prefix, Suffix: suffix, Offset: offset}},
		Quote:  exact,
		Messages: map[string]meta.Message{
			"m1": {Author: "Ada", Time: "2026-10-21T00:00:00Z", Body: "Which " + exact + "?"},
		},
	}
}

// reload loads f into a metadata doc over text, then reads it back.
func reload(t *testing.T, f *meta.File, doc *crdt.Doc) (*crdt.Doc, *meta.File) {
	t.Helper()
	m := crdt.New()
	meta.Load(m, f, doc)
	return m, meta.Read(m, &meta.File{Path: f.Path}, doc)
}

func selectorOf(t *testing.T, f *meta.File, id string) meta.Selector {
	t.Helper()
	th, ok := f.Comments[id]
	if !ok || th.Anchor.Text == nil {
		t.Fatalf("thread %s: %+v", id, th)
	}
	return *th.Anchor.Text
}

func TestLoadFindsTheTextWhereverItMoved(t *testing.T) {
	doc, _ := content("A new first line.\nhello world!\n")
	f := &meta.File{Path: "a.md", Comments: map[string]meta.Thread{"c1": textThread("world", "hello ", "!\n", 6)}}
	_, got := reload(t, f, doc)
	want := meta.Selector{Exact: "world", Prefix: "A new first line.\nhello ", Suffix: "!\n", Offset: 24}
	if s := selectorOf(t, got, "c1"); s != want {
		t.Fatalf("selector %+v, want %+v", s, want)
	}
	if m := got.Comments["c1"].Messages["m1"]; m.Body != "Which world?" || m.Author != "Ada" {
		t.Fatalf("message %+v", m)
	}
}

func TestLoadChoosesBetweenMatchesByContextThenOffset(t *testing.T) {
	doc, _ := content("say hi to the world, the world is big, the world")
	for name, c := range map[string]struct {
		sel  meta.Selector
		want int
	}{
		"context":           {meta.Selector{Exact: "world", Prefix: "the ", Suffix: " is", Offset: 0}, 25},
		"offset":            {meta.Selector{Exact: "world", Prefix: "", Suffix: "", Offset: 40}, 43},
		"context, not near": {meta.Selector{Exact: "world", Prefix: "to the ", Suffix: ",", Offset: 43}, 14},
	} {
		f := &meta.File{Path: "a.md", Comments: map[string]meta.Thread{"c1": {Anchor: meta.Anchor{Type: meta.AnchorText, Text: &c.sel}, Messages: map[string]meta.Message{}}}}
		_, got := reload(t, f, doc)
		if s := selectorOf(t, got, "c1"); s.Offset != c.want || s.Exact != "world" {
			t.Errorf("%s: %+v, want offset %d", name, s, c.want)
		}
	}
}

func TestLoadLeavesTextNotFoundDetachedAndKeepsItsPlace(t *testing.T) {
	doc, _ := content("hello there!\n")
	saved := textThread("world", "hello ", "!\n", 6)
	m := crdt.New()
	meta.Load(m, &meta.File{Path: "a.md", Comments: map[string]meta.Thread{"c1": saved}}, doc)
	thread, _ := m.GetMap(meta.CommentsKey).Get("c1")
	anchor, _ := thread.(*crdt.YMap).Get(meta.AnchorKey)
	if a := anchor.(map[string]any); a["type"] != meta.AnchorText || a["start"] != nil || a["end"] != nil {
		t.Fatalf("anchor in the doc %v", a)
	}
	// Read keeps the place it had, for the next session to try again.
	prev := &meta.File{Path: "a.md", Comments: map[string]meta.Thread{"c1": saved}}
	got := meta.Read(m, prev, doc)
	if s := selectorOf(t, got, "c1"); s != *saved.Anchor.Text {
		t.Fatalf("selector %+v, want %+v", s, *saved.Anchor.Text)
	}
}

func TestReadFollowsEditsInTheSession(t *testing.T) {
	doc, text := content("hello world!\n")
	f := &meta.File{Path: "a.md", Comments: map[string]meta.Thread{"c1": textThread("world", "hello ", "!\n", 6)}}
	m := crdt.New()
	meta.Load(m, f, doc)
	doc.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 0, "Oh, ", nil)
		text.Insert(txn, 12, "OO", nil) // inside "world"
		text.Insert(txn, 17, " and ", nil)
	})
	got := meta.Read(m, &meta.File{Path: "a.md"}, doc)
	want := meta.Selector{Exact: "woOOrld", Prefix: "Oh, hello ", Suffix: " and !\n", Offset: 10}
	if s := selectorOf(t, got, "c1"); s != want {
		t.Fatalf("selector %+v, want %+v (text %q)", s, want, text.ToString())
	}
}

func TestReadKeepsThePlaceOfTextDeletedInTheSession(t *testing.T) {
	doc, text := content("hello world!\n")
	saved := textThread("world", "hello ", "!\n", 6)
	m := crdt.New()
	meta.Load(m, &meta.File{Path: "a.md", Comments: map[string]meta.Thread{"c1": saved}}, doc)
	doc.Transact(func(txn *crdt.Transaction) { text.Delete(txn, 6, 5) })
	// ygo would resolve the end past the text; the thread keeps its place.
	got := meta.Read(m, &meta.File{Path: "a.md", Comments: map[string]meta.Thread{"c1": saved}}, doc)
	if s := selectorOf(t, got, "c1"); s != *saved.Anchor.Text {
		t.Fatalf("selector %+v, want %+v", s, *saved.Anchor.Text)
	}
}

func TestReadSavesAThreadAGuestMade(t *testing.T) {
	doc, text := content("one two three\n")
	m := crdt.New()
	comments := m.GetMap(meta.CommentsKey)
	m.Transact(func(txn *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		comments.Set(txn, "g1", thread)
		thread.Set(txn, meta.AnchorKey, map[string]any{"type": "text", "start": pos(text, 4, 0), "end": pos(text, 7, -1)})
		thread.Set(txn, meta.QuoteKey, "two")
		thread.Set(txn, meta.ResolvedKey, false)
		messages := crdt.NewMapPrelim()
		thread.Set(txn, meta.MessagesKey, messages)
		messages.Set(txn, "m1", map[string]any{"author": "Bo", "time": "2026-10-21T01:02:03.456Z", "body": "Why two?"})
		messages.Set(txn, "bad id", map[string]any{"author": "Bo", "time": "2026-10-21T01:02:03.456Z", "body": "dropped"})
		messages.Set(txn, "m2", map[string]any{"author": "Bo", "time": "now", "body": "dropped"})
		messages.Set(txn, "m3", "not a message")
	})
	got := meta.Read(m, &meta.File{Path: "a.md"}, doc)
	if s := selectorOf(t, got, "g1"); s != (meta.Selector{Exact: "two", Prefix: "one ", Suffix: " three\n", Offset: 4}) {
		t.Fatalf("selector %+v", s)
	}
	th := got.Comments["g1"]
	if th.Quote != "two" || len(th.Messages) != 1 || th.Messages["m1"].Body != "Why two?" {
		t.Fatalf("thread %+v", th)
	}
	if _, err := meta.Render(got); err != nil {
		t.Fatalf("render: %v", err)
	}
}

func TestReadSkipsWhatAFileCouldNotHold(t *testing.T) {
	doc, _ := content("abc\n")
	m := crdt.New()
	comments := m.GetMap(meta.CommentsKey)
	m.Transact(func(txn *crdt.Transaction) {
		comments.Set(txn, "not-a-map", "x")
		add := func(id string, anchor any, quote string) {
			thread := crdt.NewMapPrelim()
			comments.Set(txn, id, thread)
			thread.Set(txn, meta.AnchorKey, anchor)
			thread.Set(txn, meta.QuoteKey, quote)
		}
		add("bad id!", map[string]any{"type": "node", "id": "n1"}, "")
		add("edge", map[string]any{"type": "edge", "id": "e1"}, "")
		add("no-anchor", "x", "")
		add("long-quote", map[string]any{"type": "node", "id": "n1"}, strings.Repeat("q", meta.MaxQuote+1))
		add("lost", map[string]any{"type": "text", "start": "%%%", "end": "AAA="}, "")
		add("node", map[string]any{"type": "node", "id": "n1"}, "Ideas")
	})
	got := meta.Read(m, &meta.File{Path: "a.md"}, doc)
	if len(got.Comments) != 1 || got.Comments["node"].Anchor.ID != "n1" || got.Comments["node"].Quote != "Ideas" {
		t.Fatalf("kept %+v", got.Comments)
	}
}

func TestLoadAndReadACanvasAndACell(t *testing.T) {
	f := &meta.File{Path: "b.canvas", Comments: map[string]meta.Thread{
		"n": {Anchor: meta.Anchor{Type: meta.AnchorNode, ID: "n1"}, Quote: "Ideas", Messages: map[string]meta.Message{}},
	}}
	_, got := reload(t, f, nil)
	if got.Comments["n"].Anchor.ID != "n1" {
		t.Fatalf("canvas %+v", got.Comments)
	}

	// An empty cell is found by its neighbours.
	doc, _ := content("x,y\na,,b\n")
	cell := meta.Selector{Exact: "", Prefix: "a,", Suffix: ",b", Offset: 0}
	f = &meta.File{Path: "a.csv", Comments: map[string]meta.Thread{
		"c": {Anchor: meta.Anchor{Type: meta.AnchorCells, From: &cell, To: &cell}, Messages: map[string]meta.Message{}},
	}}
	_, got = reload(t, f, doc)
	a := got.Comments["c"].Anchor
	if a.Type != meta.AnchorCells || a.From == nil || a.From.Offset != 6 || a.From.Exact != "" || a.From.Prefix != "x,y\na," {
		t.Fatalf("cell %+v %+v", a, a.From)
	}
}

func TestReadKeepsUnknownTopLevelKeys(t *testing.T) {
	prev, err := meta.Parse([]byte(`{"version":1,"path":"a.md","comments":{},"suggestions":{"s1":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := content("abc")
	out, err := meta.Render(meta.Read(crdt.New(), prev, doc))
	if err != nil || !strings.Contains(string(out), `"suggestions"`) {
		t.Fatalf("render %s, %v", out, err)
	}
}

func TestContextIsClippedWithoutSplittingAPair(t *testing.T) {
	// 20 emoji before and after: 40 code units each way, clipped to 32.
	doc, _ := content(strings.Repeat("😀", 20) + "word" + strings.Repeat("😀", 20))
	f := &meta.File{Path: "a.md", Comments: map[string]meta.Thread{"c1": textThread("word", "", "", 40)}}
	_, got := reload(t, f, doc)
	s := selectorOf(t, got, "c1")
	if s.Prefix != strings.Repeat("😀", 16) || s.Suffix != strings.Repeat("😀", 16) || s.Offset != 40 {
		t.Fatalf("selector %+v", s)
	}
}

// guestThread adds a thread as a browser does, with positions made on text.
func guestThread(t *testing.T, m *crdt.Doc, text *crdt.YText, id string, anchor map[string]any, quote string) {
	t.Helper()
	comments := m.GetMap(meta.CommentsKey)
	m.Transact(func(txn *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		comments.Set(txn, id, thread)
		thread.Set(txn, meta.AnchorKey, anchor)
		thread.Set(txn, meta.QuoteKey, quote)
		messages := crdt.NewMapPrelim()
		thread.Set(txn, meta.MessagesKey, messages)
		messages.Set(txn, "m1", map[string]any{"author": "Bo", "time": "2026-10-21T00:00:00Z", "body": "?"})
	})
}

func pos(text *crdt.YText, i, assoc int) string {
	return base64.StdEncoding.EncodeToString(crdt.EncodeRelativePosition(crdt.CreateRelativePositionFromIndex(text, i, assoc)))
}

func TestReadFollowsARangeWhoseEdgeWasRetyped(t *testing.T) {
	doc, text := content("hello world!\n")
	m := crdt.New()
	guestThread(t, m, text, "g1", map[string]any{"type": "text", "start": pos(text, 6, 0), "end": pos(text, 11, -1)}, "world")
	doc.Transact(func(txn *crdt.Transaction) {
		text.Delete(txn, 6, 1)
		text.Insert(txn, 6, "W", nil)
		text.Delete(txn, 10, 1) // the last "d"
	})
	got := meta.Read(m, &meta.File{Path: "a.md"}, doc)
	s := selectorOf(t, got, "g1")
	// Where Yjs puts it, checked against yjs 13.6: the deleted "w" and "d"
	// stand where they were.
	if s != (meta.Selector{Exact: "Worl", Prefix: "hello ", Suffix: "!\n", Offset: 6}) {
		t.Fatalf("selector %+v (text %q)", s, text.ToString())
	}
}

func TestReadKeepsAThreadWhoseTextIsGoneByItsQuote(t *testing.T) {
	doc, text := content("hello world!\n")
	m := crdt.New()
	guestThread(t, m, text, "g1", map[string]any{"type": "text", "start": pos(text, 6, 0), "end": pos(text, 11, -1)}, "world")
	doc.Transact(func(txn *crdt.Transaction) { text.Delete(txn, 5, 6) })
	got := meta.Read(m, &meta.File{Path: "a.md"}, doc)
	if s := selectorOf(t, got, "g1"); s.Exact != "world" || len(got.Comments["g1"].Messages) != 1 {
		t.Fatalf("selector %+v", s)
	}
}

func TestReadFollowsCellsAtTheEdgesAndTypedInto(t *testing.T) {
	doc, text := content(",a,b\nx,,y")
	m := crdt.New()
	cell := func(s, e int) map[string]any {
		return map[string]any{"start": pos(text, s, -1), "end": pos(text, e, 0)}
	}
	// The empty first cell, and the empty cell between x and y.
	guestThread(t, m, text, "first", map[string]any{"type": "cells", "from": cell(0, 0), "to": cell(0, 0)}, "")
	guestThread(t, m, text, "middle", map[string]any{"type": "cells", "from": cell(7, 7), "to": cell(7, 7)}, "")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 7, "Z", nil) })
	got := meta.Read(m, &meta.File{Path: "a.csv"}, doc)
	if a := got.Comments["first"].Anchor; a.From == nil || a.From.Exact != "" || a.From.Offset != 0 || a.From.Suffix != ",a,b\nx,Z,y" {
		t.Fatalf("first %+v", a.From)
	}
	if a := got.Comments["middle"].Anchor; a.From == nil || a.From.Exact != "Z" || a.From.Offset != 7 {
		t.Fatalf("middle %+v", a.From)
	}
	// And back in the next session.
	_, again := reload(t, got, doc)
	if a := again.Comments["middle"].Anchor; a.From == nil || a.From.Exact != "Z" || a.From.Offset != 7 {
		t.Fatalf("reloaded %+v", a.From)
	}
}

func TestReadKeepsTheSameThreadsEveryTime(t *testing.T) {
	doc, _ := content("abc\n")
	m := crdt.New()
	comments := m.GetMap(meta.CommentsKey)
	m.Transact(func(txn *crdt.Transaction) {
		for i := range meta.MaxThreads + 20 {
			thread := crdt.NewMapPrelim()
			comments.Set(txn, fmt.Sprintf("t%04d", i), thread)
			thread.Set(txn, meta.AnchorKey, map[string]any{"type": "node", "id": "n"})
		}
	})
	got := meta.Read(m, &meta.File{Path: "a.md"}, doc)
	if len(got.Comments) != meta.MaxThreads {
		t.Fatalf("%d threads", len(got.Comments))
	}
	if _, ok := got.Comments[fmt.Sprintf("t%04d", meta.MaxThreads-1)]; !ok {
		t.Fatal("did not keep the first by id")
	}
}

func TestReadKeepsTheFileUnderItsSize(t *testing.T) {
	doc, _ := content("abc\n")
	m := crdt.New()
	comments := m.GetMap(meta.CommentsKey)
	m.Transact(func(txn *crdt.Transaction) {
		for i := range 300 {
			thread := crdt.NewMapPrelim()
			comments.Set(txn, fmt.Sprintf("t%03d", i), thread)
			thread.Set(txn, meta.AnchorKey, map[string]any{"type": "node", "id": "n"})
			messages := crdt.NewMapPrelim()
			thread.Set(txn, meta.MessagesKey, messages)
			messages.Set(txn, "m", map[string]any{"author": "a", "time": "2026-10-21T00:00:00Z", "body": strings.Repeat("あ", meta.MaxBody)})
		}
	})
	got := meta.Read(m, &meta.File{Path: "a.md"}, doc)
	if _, err := meta.Render(got); err != nil || len(got.Comments) == 300 || len(got.Comments) == 0 {
		t.Fatalf("%d threads: %v", len(got.Comments), err)
	}
}

func TestLoadFindsQuickly(t *testing.T) {
	doc, _ := content(strings.Repeat("a", 1<<20))
	sel := meta.Selector{Exact: strings.Repeat("a", meta.MaxQuote-1) + "b"}
	threads := map[string]meta.Thread{}
	for i := range 50 {
		threads[fmt.Sprintf("c%d", i)] = meta.Thread{Anchor: meta.Anchor{Type: meta.AnchorText, Text: &sel}, Messages: map[string]meta.Message{}}
	}
	start := time.Now()
	meta.Load(crdt.New(), &meta.File{Path: "a.md", Comments: threads}, doc)
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("Load took %v", d)
	}
}
