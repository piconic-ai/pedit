package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

func TestKeptInitialCapturesFilesAndRejectsChanges(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	metadata := filepath.Join(dir, ".pedit", "meta", "notes.md.json")
	if err := os.WriteFile(file, []byte("hello world!"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(metadata), 0700); err != nil {
		t.Fatal(err)
	}
	original := `{"version":1,"path":"notes.md","comments":{"c1":{"anchor":{"type":"text","exact":"world","prefix":"hello ","suffix":"!","offset":6},"quote":"world","resolved":false,"messages":{"m1":{"author":"Ada","time":"2026-10-21T00:00:00Z","body":"Which world?"}}}}}`
	if err := os.WriteFile(metadata, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := captureKeptInitial(file, dir, protocol.KeptAttachmentsNone)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	payload, err := protocol.DecodeKeptTextPayload(s.payload, 10)
	if err != nil {
		t.Fatal(err)
	}
	doc := crdt.New()
	defer doc.Destroy()
	if err = crdt.ApplyUpdateV1(doc, payload.Documents[1], nil); err != nil {
		t.Fatal(err)
	}
	if len(doc.GetMap("comments").Keys()) != 1 || s.comments != original || s.text != "hello world!" {
		t.Fatal("initial text/comments were not captured")
	}
	textDoc := crdt.New()
	defer textDoc.Destroy()
	if err = crdt.ApplyUpdateV1(textDoc, payload.Documents[0], nil); err != nil {
		t.Fatal(err)
	}
	old, err := meta.Parse([]byte(original))
	if err != nil {
		t.Fatal(err)
	}
	restored := meta.Read(doc, old, meta.NewTracker(textDoc))
	thread := restored.Comments["c1"]
	if thread.Quote != "world" || thread.Messages["m1"].Body != "Which world?" || thread.Anchor.Text == nil || thread.Anchor.Text.Exact != "world" {
		t.Fatalf("comment did not survive checkpoint: %#v", thread)
	}
	if err = os.WriteFile(metadata, []byte(original+" "), 0600); err != nil {
		t.Fatal(err)
	}
	if s.verify() == nil {
		t.Fatal("modified metadata accepted")
	}
	if err = os.WriteFile(metadata, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(file, file+".old"); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(file, []byte("hello world!"), 0600); err != nil {
		t.Fatal(err)
	}
	if s.verify() == nil {
		t.Fatal("replaced file accepted")
	}
}

func TestKeptInitialRejectsInvalidMetadataAndUnverifiedAttachments(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(file, []byte("text"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := captureKeptInitial(file, dir, protocol.KeptAttachmentsUnverified); err == nil {
		t.Fatal("unverified attachments accepted")
	}
	metadata := filepath.Join(dir, ".pedit", "meta", "notes.md.json")
	if err := os.MkdirAll(filepath.Dir(metadata), 0700); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{`, `{"version":1,"path":"other.md","comments":{}}`} {
		if err := os.WriteFile(metadata, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := captureKeptInitial(file, dir, protocol.KeptAttachmentsNone); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestKeptInitialRejectsNewMetadataAndSymlinkDirectory(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(file, []byte("text"), 0600); err != nil {
		t.Fatal(err)
	}
	s, err := captureKeptInitial(file, dir, protocol.KeptAttachmentsNone)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	metadata := filepath.Join(dir, ".pedit", "meta", "notes.md.json")
	if err = os.MkdirAll(filepath.Dir(metadata), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(metadata, []byte(`{"version":1,"path":"notes.md","comments":{}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if s.verify() == nil {
		t.Fatal("new metadata accepted")
	}
	other := t.TempDir()
	file2 := filepath.Join(other, "notes.md")
	if err = os.WriteFile(file2, []byte("text"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(t.TempDir(), filepath.Join(other, ".pedit")); err != nil {
		t.Fatal(err)
	}
	if _, err = captureKeptInitial(file2, other, protocol.KeptAttachmentsNone); err == nil {
		t.Fatal("symlink metadata directory accepted")
	}
}
