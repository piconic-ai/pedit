package serve

import (
	"errors"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
)

func adopt(s *Server, doc []byte, generation string) error {
	return s.Adopt(func(string) ([]byte, string, error) { return doc, generation, nil })
}

func docWith(text string) []byte {
	d := crdt.New()
	t := d.GetText("content")
	d.Transact(func(txn *crdt.Transaction) { t.Insert(txn, 0, text, nil) })
	return crdt.EncodeStateAsUpdateV1(d, nil)
}

func TestServerAdoptReplacesTheDocumentAndEndsTheStreams(t *testing.T) {
	s, file, _ := open(t, "old\n")
	c := dial(t, s)
	eventually(t, "synced", func() bool { return c.get() == "old\n" })
	before := s.Generation()

	if err := adopt(s, docWith("new text\n"), "G2"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-c.done:
	case <-time.After(5 * time.Second):
		t.Fatal("the stream was not closed")
	}
	var ce closeErr
	if !errors.As(c.err, &ce) || ce.code != 4001 {
		t.Fatalf("stream ended with %v", c.err)
	}
	if s.Generation() != "G2" || s.Generation() == before || s.Text() != "new text\n" {
		t.Fatalf("generation %q, text %q", s.Generation(), s.Text())
	}
	// The file and the state are written before Adopt returns.
	if !fileIs(t, file, "new text\n")() {
		t.Fatal("the file does not hold the new text")
	}
	if rec := readState(s.statePath); rec == nil || rec.Generation != "G2" {
		t.Fatalf("state %v", rec)
	}
	// A page that comes back sees the new document, and edits go on to the file.
	c2 := dial(t, s)
	eventually(t, "the new document", func() bool { return c2.get() == "new text\n" })
	c2.insert(0, "x:")
	eventually(t, "the edit is written", fileIs(t, file, "x:new text\n"))
}

func TestServerAdoptWithoutAGenerationMakesANewOne(t *testing.T) {
	s, _, _ := open(t, "old\n")
	before := s.Generation()
	if err := adopt(s, docWith("a\n"), ""); err != nil {
		t.Fatal(err)
	}
	if g := s.Generation(); g == "" || g == before {
		t.Fatalf("generation %q, was %q", g, before)
	}
}

func TestServerAdoptRefusesWhatItCannotUse(t *testing.T) {
	s, _, _ := open(t, "old\n")
	if err := adopt(s, []byte{1, 2, 3}, "G"); err == nil {
		t.Fatal("adopted garbage")
	}
	p, err := s.AttachPeer(PeerHandler{})
	if err != nil {
		t.Fatal(err)
	}
	if err := adopt(s, docWith("a\n"), "G"); err == nil {
		t.Fatal("adopted with a room attached")
	}
	p.Close()
	if s.Text() != "old\n" || s.Generation() == "G" {
		t.Fatalf("a refused adopt changed %q, %q", s.Text(), s.Generation())
	}
}

func TestServerEditMergesTheChangeIntoWhatWasWritten(t *testing.T) {
	s, file, _ := open(t, "hello\n")
	c := dial(t, s)
	eventually(t, "synced", func() bool { return c.get() == "hello\n" })
	c.insert(0, "app: ")
	eventually(t, "the server has it", func() bool { return s.Text() == "app: hello\n" })
	update, generation := s.PrepareEdit("hello\n", "hello\nroom\n")
	if s.Text() != "app: hello\n" {
		t.Fatalf("PrepareEdit changed the document: %q", s.Text())
	}
	if !s.ApplyUpdate(update, generation) {
		t.Fatal("not applied")
	}
	eventually(t, "the page gets the edit", func() bool { return c.get() == "app: hello\nroom\n" })
	eventually(t, "the file", fileIs(t, file, "app: hello\nroom\n"))
}

// An edit the server accepts after the text was first looked at, but before
// the document is replaced, is in what merge is given, so the replacement
// keeps it.
func TestServerAdoptSeesEditsAcceptedUntilTheReplacement(t *testing.T) {
	s, file, _ := open(t, "hello\n")
	c := dial(t, s)
	eventually(t, "synced", func() bool { return c.get() == "hello\n" })
	stale := s.Text()
	c.insert(0, "late: ")
	eventually(t, "the server has the edit", func() bool { return s.Text() == "late: hello\n" })
	var given string
	err := s.Adopt(func(app string) ([]byte, string, error) {
		given = app
		return docWith(app + "room\n"), "G2", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if stale != "hello\n" || given != "late: hello\n" {
		t.Fatalf("stale %q, merge was given %q", stale, given)
	}
	if s.Text() != "late: hello\nroom\n" || !fileIs(t, file, "late: hello\nroom\n")() {
		t.Fatalf("adopted %q", s.Text())
	}
}

func TestServerApplyUpdateReappliesAnEditOnceAndOnlyInItsGeneration(t *testing.T) {
	s, file, _ := open(t, "abc\n")
	update, generation := s.PrepareEdit("abc\n", "ac\n")
	if s.Text() != "abc\n" || !s.ApplyUpdate(update, generation) {
		t.Fatalf("text %q", s.Text())
	}
	if generation != s.Generation() || s.Text() != "ac\n" {
		t.Fatalf("generation %q, text %q", generation, s.Text())
	}
	// What the edit made is already there: nothing changes, and what was typed
	// since is not undone.
	c := dial(t, s)
	eventually(t, "synced", func() bool { return c.get() == "ac\n" })
	c.insert(1, "X")
	eventually(t, "the server has it", func() bool { return s.Text() == "aXc\n" })
	if !s.ApplyUpdate(update, generation) || s.Text() != "aXc\n" {
		t.Fatalf("text %q", s.Text())
	}
	if s.ApplyUpdate(update, "another") {
		t.Fatal("applied in another generation")
	}
	// An update whose dependencies are missing is refused.
	other := crdt.New()
	ot := other.GetText("content")
	other.Transact(func(txn *crdt.Transaction) { ot.Insert(txn, 0, "z", nil) })
	before := other.StateVector()
	other.Transact(func(txn *crdt.Transaction) { ot.Insert(txn, 1, "y", nil) })
	if s.ApplyUpdate(crdt.EncodeStateAsUpdateV1(other, before), s.Generation()) {
		t.Fatal("applied an update with missing dependencies")
	}
	eventually(t, "the file", fileIs(t, file, "aXc\n"))
}
