package meta

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
)

func TestTrackerDoesNotAskAgainForWhatItCannotPlace(t *testing.T) {
	content := crdt.New()
	text := content.GetText(ContentText)
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "abc", nil) })
	tr := NewTracker(content)
	defer tr.Close()
	gone := encodePosition(crdt.CreateRelativePositionFromIndex(text, 1, 0))
	content.Transact(func(txn *crdt.Transaction) { text.Delete(txn, 1, 1) })
	unknown := encodePosition(crdt.RelativePosition{Item: &crdt.ID{Client: 7, Clock: 3}})

	tr.learn(gone)
	tr.learn(unknown)
	if _, ok := tr.lookup(gone); ok {
		t.Fatal("placed a deleted character")
	}
	if _, ok := tr.lookup(unknown); ok {
		t.Fatal("placed a character not received")
	}
	if !tr.gone[gone] || tr.unknown[unknown] != tr.gen {
		t.Fatalf("gone %v unknown %v", tr.gone, tr.unknown)
	}
	// Neither costs a try again; the unknown one does once the text changes.
	tried := tr.tried
	tr.learn(gone)
	tr.learn(unknown)
	if tr.tried != tried {
		t.Fatalf("tried %d, then %d", tried, tr.tried)
	}
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "x", nil) })
	tr.learn(unknown)
	if tr.tried != tried+1 {
		t.Fatalf("did not ask again after the text changed: %d", tr.tried)
	}
	// Forgotten with their anchors.
	tr.keep(map[string]bool{})
	if len(tr.gone)+len(tr.unknown) != 0 {
		t.Fatalf("kept %v %v", tr.gone, tr.unknown)
	}
}

func TestTrackerFollowsABatchOfCommentsWhole(t *testing.T) {
	// From review: 33 comments in one update, then the first character of
	// the last one deleted, before anything else reads the comments.
	content := crdt.New()
	text := content.GetText(ContentText)
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, strings.Repeat("abc", 33), nil) })
	followBatch(t, content, 0, 33)
}

func TestTrackerFollowsABatchOfCommentsWholeOnALongText(t *testing.T) {
	// From review: 300,000 characters in 10,000 items, and MaxThreads
	// comments in one update.
	content := crdt.New()
	text := content.GetText(ContentText)
	content.Transact(func(txn *crdt.Transaction) {
		for range 10000 {
			text.Insert(txn, 0, strings.Repeat("abc", 10), nil)
		}
	})
	followBatch(t, content, 297999, MaxThreads)
}

// followBatch adds n comments in one update, each on the "bc" of an "abc"
// from at, and checks the last still covers what is left of it once its "b"
// is deleted.
func followBatch(t *testing.T, content *crdt.Doc, at, n int) {
	t.Helper()
	text := content.GetText(ContentText)
	doc := crdt.New()
	comments := doc.GetMap(CommentsKey)
	doc.Transact(func(txn *crdt.Transaction) {
		for i := range n {
			thread := crdt.NewMapPrelim()
			comments.Set(txn, fmt.Sprintf("t%03d", i), thread)
			thread.Set(txn, AnchorKey, map[string]any{
				typeKey:  AnchorText,
				startKey: encodePosition(crdt.CreateRelativePositionFromIndex(text, at+3*i+1, 0)),
				endKey:   encodePosition(crdt.CreateRelativePositionFromIndex(text, at+3*i+3, -1)),
			})
			thread.Set(txn, QuoteKey, "bc")
			thread.Set(txn, ResolvedKey, false)
			messages := crdt.NewMapPrelim()
			thread.Set(txn, MessagesKey, messages)
			messages.Set(txn, "m", map[string]any{"author": "a", "time": "2026-01-01T00:00:00Z", "body": "b"})
		}
	})
	tr := NewTracker(content)
	defer tr.Close()
	// However slow the test runs (such as with -race), no time passes.
	tr.now = func() time.Time { return time.Unix(1, 0) }
	tr.Learn(doc)
	last := at + 3*(n-1) + 1
	content.Transact(func(txn *crdt.Transaction) { text.Delete(txn, last, 1) })
	f := Read(doc, &File{}, tr)
	got := f.Comments[fmt.Sprintf("t%03d", n-1)].Anchor.Text
	if got == nil || got.Exact != "c" || got.Offset != last {
		t.Fatalf("saved %+v", got)
	}
}

func TestTrackerKeysAPositionHoweverItIsWritten(t *testing.T) {
	// From review: base64 with a line break in it, and an assoc of 5, name
	// the same position as pedit's own encoding with assoc 0.
	content := crdt.New()
	text := content.GetText(ContentText)
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "abc", nil) })
	tr := NewTracker(content)
	defer tr.Close()
	p := crdt.CreateRelativePositionFromIndex(text, 1, 0)
	own := encodePosition(p)
	p.Assoc = 5
	other := encodePosition(p)
	other = other[:4] + "\n" + other[4:]
	for _, k := range []string{own, other} {
		key, ok := canonical(k)
		if !ok || key != own {
			t.Fatalf("canonical(%q) = %q, %v", k, key, ok)
		}
	}
	tr.learn(own)
	if i, ok := tr.lookup(other); !ok || i != 1 {
		t.Fatalf("lookup = %d, %v", i, ok)
	}
}

func TestLearnStopsPlacingAfterMaxLearn(t *testing.T) {
	content := crdt.New()
	text := content.GetText(ContentText)
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, strings.Repeat("abc", 4), nil) })
	doc := crdt.New()
	comments := doc.GetMap(CommentsKey)
	doc.Transact(func(txn *crdt.Transaction) {
		for i := range 4 {
			thread := crdt.NewMapPrelim()
			comments.Set(txn, fmt.Sprintf("t%d", i), thread)
			thread.Set(txn, AnchorKey, map[string]any{
				typeKey:  AnchorText,
				startKey: encodePosition(crdt.CreateRelativePositionFromIndex(text, 3*i, 0)),
				endKey:   encodePosition(crdt.CreateRelativePositionFromIndex(text, 3*i+1, -1)),
			})
		}
	})
	tr := NewTracker(content)
	defer tr.Close()
	// Each look at the clock is a quarter of maxLearn later.
	now := time.Unix(1, 0)
	tr.now = func() time.Time {
		now = now.Add(maxLearn / 4)
		return now
	}
	tr.Learn(doc)
	if tr.tried == 0 || tr.tried >= 8 {
		t.Fatalf("placed %d of 8 positions", tr.tried)
	}
	// The next Learn places the rest.
	tr.now = time.Now
	tr.Learn(doc)
	if len(tr.pos) != 8 {
		t.Fatalf("follows %d of 8 positions", len(tr.pos))
	}
}

func TestReadFollowsNoNewPosition(t *testing.T) {
	// From review: Read runs outside the time protocol.AddCheckedFile
	// bounds, so only Learn may ask ygo.
	content := crdt.New()
	text := content.GetText(ContentText)
	content.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "abc", nil) })
	doc := crdt.New()
	comments := doc.GetMap(CommentsKey)
	doc.Transact(func(txn *crdt.Transaction) {
		thread := crdt.NewMapPrelim()
		comments.Set(txn, "t", thread)
		thread.Set(txn, AnchorKey, map[string]any{
			typeKey:  AnchorText,
			startKey: encodePosition(crdt.CreateRelativePositionFromIndex(text, 1, 0)),
			endKey:   encodePosition(crdt.CreateRelativePositionFromIndex(text, 3, -1)),
		})
	})
	tr := NewTracker(content)
	defer tr.Close()
	Read(doc, &File{}, tr)
	if tr.tried != 0 {
		t.Fatalf("Read asked ygo for %d positions", tr.tried)
	}
}

func TestFindIgnoresMatchesOffTheCharacters(t *testing.T) {
	// From review: U+0102 repeated holds the bytes of U+0201 at every odd
	// offset of UTF-16, and nowhere on a character.
	content := strings.Repeat("Ă", 1<<19)
	h := newHaystack(content)
	units := []uint16{}
	for range 1 << 19 {
		units = append(units, 0x0102)
	}
	start := time.Now()
	for range 100 {
		if a, _ := find(&Selector{Exact: "ȁ"}, units, h); a != -1 {
			t.Fatalf("found at %d", a)
		}
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("took %v", d)
	}
}
