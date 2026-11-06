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
	s.Edit("hello\n", "hello\nroom\n")
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
