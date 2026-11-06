package serve

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/reearth/ygo/crdt"
)

// openWith serves the file with the kept room's record that rf gives.
func (r *restarter) openWith(rf func(file string) (string, []byte, string, *string, bool)) *Server {
	r.t.Helper()
	s, err := Open(r.file, Options{
		App:        "test",
		WriteDelay: 20 * time.Millisecond,
		StateDir:   r.base,
		RecordFor:  rf,
		OnError:    func(err error) { r.t.Log("serve error:", err) },
	})
	if err != nil {
		r.t.Fatal(err)
	}
	return s
}

func recordOf(generation string, doc []byte, text string) func(string) (string, []byte, string, *string, bool) {
	return func(string) (string, []byte, string, *string, bool) { return generation, doc, text, nil, true }
}

// closedWithState serves the file once and returns its state, saved at close.
func closedWithState(t *testing.T, r *restarter) (stateRecord, string) {
	t.Helper()
	s := r.open()
	path := s.statePath
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	rec := readState(path)
	if rec == nil {
		t.Fatal("no state after a clean exit")
	}
	return *rec, path
}

func TestADamagedStateStartsFromAFittingRecord(t *testing.T) {
	r := newRestarter(t, "hello\n")
	rec, path := closedWithState(t, r)
	if err := os.WriteFile(path, []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := r.openWith(recordOf("kept-gen", rec.Doc, "hello\n"))
	defer s.Close()
	if s.Generation() != "kept-gen" || s.render() != "hello\n" {
		t.Fatalf("generation %q, doc %q", s.Generation(), s.render())
	}
	// The record's document, not a new one holding the same text.
	s.mu.Lock()
	doc := crdt.EncodeStateAsUpdateV1(s.doc, nil)
	s.mu.Unlock()
	if !bytes.Equal(doc, rec.Doc) {
		t.Fatal("the doc is not the record's")
	}
}

func TestAMissingStateStartsFromARecordAndMergesAnExternalSave(t *testing.T) {
	r := newRestarter(t, "hello\n")
	rec, path := closedWithState(t, r)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	// The file changed since the record, as an editor saves it.
	write(t, r.file, "hello world\n")
	s := r.openWith(recordOf("kept-gen", rec.Doc, "hello\n"))
	defer s.Close()
	if s.Generation() != "kept-gen" || s.render() != "hello world\n" {
		t.Fatalf("generation %q, doc %q", s.Generation(), s.render())
	}
}

func TestARecordThatDoesNotFitItsFileStartsAfresh(t *testing.T) {
	r := newRestarter(t, "hello\n")
	rec, path := closedWithState(t, r)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	// The record says the file held other text than its document renders.
	s := r.openWith(recordOf("kept-gen", rec.Doc, "other\n"))
	defer s.Close()
	if s.Generation() == "kept-gen" || s.render() != "hello\n" {
		t.Fatalf("generation %q, doc %q", s.Generation(), s.render())
	}
}

// A kept record whose document is ahead of its file (a write in doubt) is
// used, and the file gets the document.
func TestARecordWithAPendingTextStartsAheadOfTheFile(t *testing.T) {
	r := newRestarter(t, "hello\n")
	_, path := closedWithState(t, r)
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	text := doc.GetText("content")
	doc.Transact(func(txn *crdt.Transaction) { text.Insert(txn, 0, "hello world\n", nil) })
	pending := "hello world\n"
	s := r.openWith(func(string) (string, []byte, string, *string, bool) {
		return "kept-gen", crdt.EncodeStateAsUpdateV1(doc, nil), "hello\n", &pending, true
	})
	defer s.Close()
	if s.Generation() != "kept-gen" || s.render() != "hello world\n" {
		t.Fatalf("generation %q, doc %q", s.Generation(), s.render())
	}
}

func TestAnOldStateIsKeptWhileARecordHasItsGeneration(t *testing.T) {
	r := newRestarter(t, "hello\n")
	rec, path := closedWithState(t, r)
	rec.Saved = time.Now().Add(-stateMaxAge - time.Hour)
	if err := writeState(path, rec); err != nil {
		t.Fatal(err)
	}
	// With the record of another document, it has expired.
	s := r.openWith(recordOf("another", rec.Doc, "hello\n"))
	same := s.Generation() == rec.Generation
	_ = s.Close()
	if same {
		t.Fatal("an old state was used for another generation's record")
	}
	if err := writeState(path, rec); err != nil {
		t.Fatal(err)
	}
	s = r.openWith(recordOf(rec.Generation, rec.Doc, "hello\n"))
	defer s.Close()
	if s.Generation() != rec.Generation {
		t.Fatalf("generation %q, want the state's %q", s.Generation(), rec.Generation)
	}
}
