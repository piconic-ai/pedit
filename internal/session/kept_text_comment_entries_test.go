package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// commentEntryScene is a kept record of notes.md with a comments doc, and the
// update a guest makes to that doc.
type commentEntryScene struct {
	keys     *protocol.RoomKeys
	state    keptTextState
	metaName string
	notes    string
	snapshot []byte
	metaID   uint32
	update   []byte
}

func newCommentEntryScene(t *testing.T) *commentEntryScene {
	t.Helper()
	keys, _, _, _ := keptFixFrames(t)
	dir := t.TempDir()
	notes := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(notes, []byte("hello world"), 0o600); err != nil {
		t.Fatal(err)
	}
	files, err := prepareKeptFiles(dir, notes)
	if err != nil {
		t.Fatal(err)
	}
	m := files[0].Meta
	if m == nil {
		t.Fatal("no comments doc")
	}
	guestText, guestMeta := crdt.New(), crdt.New()
	for doc, state := range map[*crdt.Doc][]byte{guestText: files[0].State, guestMeta: m.State} {
		if err := crdt.ApplyUpdateV1(doc, state, nil); err != nil {
			t.Fatal(err)
		}
	}
	vector := guestMeta.StateVector()
	tracker := meta.NewTracker(guestText)
	meta.Load(guestMeta, &meta.File{Path: "notes.md", Comments: map[string]meta.Thread{"t2": keptCommentThread("hello", 0)}}, tracker)
	tracker.Close()
	s := &commentEntryScene{
		keys: keys, metaName: filepath.Join(dir, ".pedit", "meta", "notes.md.json"), notes: notes, metaID: m.ID,
		state:  keptTextState{Project: dir, Origin: "https://example.test", Files: files, CommentEntries: true},
		update: crdt.EncodeStateAsUpdateV1(guestMeta, vector),
	}
	h := s.host(t, s.state)
	if s.snapshot, err = h.snapshot(); err != nil {
		t.Fatal(err)
	}
	h.closeFiles()
	return s
}

func (s *commentEntryScene) host(t *testing.T, state keptTextState) *keptTextHost {
	t.Helper()
	h := &keptTextHost{state: state, keys: s.keys, path: filepath.Join(t.TempDir(), "state.json"), room: "abcdefghijklmnopqrstuv"}
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(h.closeFiles)
	return h
}

func (s *commentEntryScene) comment(t *testing.T, i uint64, id uint32, update []byte) keptTextEntry {
	t.Helper()
	frame, err := protocol.SealKeptCommentUpdate(s.keys, id, update)
	if err != nil {
		t.Fatal(err)
	}
	return keptTextEntry{ID: i, Body: frame}
}

func (s *commentEntryScene) read(entries ...keptTextEntry) keptTextRead {
	return keptTextRead{Snapshot: s.snapshot, Tail: uint64(len(entries)), Entries: entries}
}

func TestResumeTakesInACommentEntryForACommentsDoc(t *testing.T) {
	s := newCommentEntryScene(t)
	h := s.host(t, s.state)
	takeInRead(t, h, s.read(s.comment(t, 1, s.metaID, s.update)))
	if h.skipped != 0 {
		t.Fatalf("skipped %d", h.skipped)
	}
	written, err := os.ReadFile(s.metaName)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := meta.Parse(written)
	if err != nil || parsed.Comments["t2"].Anchor.Text == nil || parsed.Comments["t2"].Anchor.Text.Exact != "hello" {
		t.Fatalf("metadata file after resume: %s (%v)", written, err)
	}
	if text, _ := os.ReadFile(s.notes); string(text) != "hello world" {
		t.Fatalf("a comment reached the shared file: %q", text)
	}
}

func TestResumeSkipsCommentEntriesThatDoNotQualify(t *testing.T) {
	s := newCommentEntryScene(t)
	h := s.host(t, s.state)
	takeInRead(t, h, s.read(
		s.comment(t, 1, 0, s.update),                  // the text file
		s.comment(t, 2, 77, s.update),                 // an unknown id
		s.comment(t, 3, s.metaID, []byte{0xff, 0xff}), // fails the meta check
	))
	if h.skipped != 3 {
		t.Fatalf("skipped %d, want 3", h.skipped)
	}
	if _, err := os.Stat(s.metaName); err == nil {
		t.Fatal("a skipped entry wrote comments")
	}
	if text, _ := os.ReadFile(s.notes); string(text) != "hello world" {
		t.Fatalf("notes.md = %q", text)
	}
}

func TestResumeTakesInEditEntriesForCommentsAsBefore(t *testing.T) {
	s := newCommentEntryScene(t)
	frame, err := protocol.SealKeptFileUpdate(s.keys, s.metaID, s.update)
	if err != nil {
		t.Fatal(err)
	}
	h := s.host(t, s.state)
	takeInRead(t, h, s.read(keptTextEntry{ID: 1, Body: frame}))
	written, _ := os.ReadFile(s.metaName)
	if h.skipped != 0 || !strings.Contains(string(written), `"hello"`) {
		t.Fatalf("skipped %d, file %s", h.skipped, written)
	}
}

func TestCommentEntriesFieldIsWrittenAndOlderRecordsStillLoad(t *testing.T) {
	s := newCommentEntryScene(t)
	path := filepath.Join(t.TempDir(), "state.json")
	if err := saveKeptState(path, s.state); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"CommentEntries":true`) {
		t.Fatalf("record lacks the field: %s", raw)
	}
	var got keptTextState
	if err := readKeptState(path, &got); err != nil || !got.CommentEntries {
		t.Fatalf("read %+v, %v", got, err)
	}
	// A record a version 7 pedit wrote has no such field and still loads.
	old := s.state
	old.CommentEntries = false
	if err := saveKeptState(path, old); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	if strings.Contains(string(raw), `"CommentEntries"`) {
		t.Fatalf("an older record carries the field: %s", raw)
	}
	got = keptTextState{}
	if err := readKeptState(path, &got); err != nil || got.CommentEntries {
		t.Fatalf("read %+v, %v", got, err)
	}
}
