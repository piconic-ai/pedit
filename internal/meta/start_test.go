package meta_test

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/reearth/ygo/crdt"
)

// contentDoc is a text file's doc holding s.
func contentDoc(s string) (*crdt.Doc, *crdt.YText) {
	d := crdt.New()
	t := d.GetText(meta.ContentText)
	d.Transact(func(txn *crdt.Transaction) { t.Insert(txn, 0, s, nil) })
	return d, t
}

func TestAThreadIsStartedAsTheBrowserStartsOne(t *testing.T) {
	content, text := contentDoc("Hello wide world")
	m := crdt.New()
	tr := meta.NewTracker(content)
	defer tr.Close()
	state := string(crdt.EncodeStateAsUpdateV1(m, nil))
	u, err := meta.StartUpdate(m, text, "t1", "m1", "tate‮-pm", at, 6, 10, "Why wide?")
	if string(crdt.EncodeStateAsUpdateV1(m, nil)) != state {
		t.Fatal("the doc changed before the update was applied")
	}
	apply(t, m, u, err)
	tr.Learn(m)
	if err := meta.CheckUpdate(crdt.New(), crdt.EncodeStateAsUpdateV1(m, nil)); err != nil {
		t.Fatalf("a peer starting afresh refuses the doc: %v", err)
	}
	th := meta.ShownThreads(m)
	if len(th) != 1 || th[0].Quote != "wide" || th[0].Kind != meta.AnchorText || th[0].Resolved ||
		len(th[0].Messages) != 1 || th[0].Messages[0] != (meta.ShownMessage{ID: "m1", Author: "tate-pm", Time: at, Body: "Why wide?"}) {
		t.Fatalf("%+v", th)
	}
	if got := meta.TextPlaces(m, tr)["t1"]; got != [2]int{6, 10} {
		t.Fatalf("placed at %v", got)
	}
	// Text typed at either edge stays outside; text before it moves it.
	content.Transact(func(txn *crdt.Transaction) {
		text.Insert(txn, 10, "!!", nil)
		text.Insert(txn, 6, "so ", nil)
		text.Insert(txn, 0, ">> ", nil)
	})
	if got := meta.TextPlaces(m, tr)["t1"]; got != [2]int{12, 16} {
		t.Fatalf("after edits %v in %q", got, text.ToString())
	}
	// The text it covered is deleted: it cannot be placed.
	content.Transact(func(txn *crdt.Transaction) { text.Delete(txn, 12, 4) })
	if _, ok := meta.TextPlaces(m, tr)["t1"]; ok {
		t.Fatal("a thread on deleted text is placed")
	}
}

func TestAThreadBreakingARuleIsRefused(t *testing.T) {
	_, text := contentDoc("a😀b" + strings.Repeat("x", meta.MaxQuote+5))
	m := crdt.New()
	for _, tc := range []struct {
		name     string
		thread   string
		from, to int
		body     string
		want     error
	}{
		{"empty", "t1", 2, 2, "hi", meta.ErrBadRange},
		{"backwards", "t1", 3, 1, "hi", meta.ErrBadRange},
		{"negative", "t1", -1, 2, "hi", meta.ErrBadRange},
		{"past the end", "t1", 0, 1 << 20, "hi", meta.ErrBadRange},
		{"cuts a pair at the start", "t1", 2, 4, "hi", meta.ErrSplitPair},
		{"cuts a pair at the end", "t1", 0, 2, "hi", meta.ErrSplitPair},
		{"too long", "t1", 0, meta.MaxQuote + 1, "hi", meta.ErrQuoteTooLong},
		{"bad id", "bad id", 0, 1, "hi", meta.ErrInvalidID},
		{"empty body", "t1", 0, 1, " \n", meta.ErrEmptyBody},
		{"long body", "t1", 0, 1, strings.Repeat("x", meta.MaxBody+1), meta.ErrBodyTooLong},
	} {
		if _, err := meta.StartUpdate(m, text, tc.thread, "m1", "Ada", at, tc.from, tc.to, tc.body); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", tc.name, err, tc.want)
		}
	}
	// A pair is quoted whole.
	u, err := meta.StartUpdate(m, text, "t1", "m1", "Ada", at, 0, 4, "hi")
	apply(t, m, u, err)
	if q := meta.ShownThreads(m)[0].Quote; q != "a😀b" {
		t.Fatalf("quote %q", q)
	}
	if _, err := meta.StartUpdate(m, text, "t1", "m2", "Ada", at, 0, 1, "again"); !errors.Is(err, meta.ErrIDTaken) {
		t.Fatalf("a thread id in use: %v", err)
	}
}

func TestThreadsAreLimited(t *testing.T) {
	_, text := contentDoc("some text")
	m := crdt.New()
	comments := m.GetMap(meta.CommentsKey)
	m.Transact(func(txn *crdt.Transaction) {
		for i := range meta.MaxThreads {
			comments.Set(txn, fmt.Sprintf("t%d", i), "x")
		}
	})
	if _, err := meta.StartUpdate(m, text, "new", "m1", "Ada", at, 0, 4, "hi"); !errors.Is(err, meta.ErrThreadsFull) {
		t.Fatal(err)
	}
}
