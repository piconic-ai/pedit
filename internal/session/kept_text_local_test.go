package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// keptLocalRoom returns a host about to resume a kept room whose checkpoint
// holds three lines and whose log holds one guest edit to line 1, with the
// source file on disk set to local, and what the relay replays to it.
func keptLocalRoom(t *testing.T, local string, guestEdit bool) (*keptTextHost, keptTextRead) {
	t.Helper()
	keys, _, _, _ := keptFixFrames(t)
	const base = "one\ntwo\nthree\n"
	doc := crdt.New()
	defer doc.Destroy()
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, base, nil) })
	checkpoint := crdt.EncodeStateAsUpdateV1(doc, nil)
	vector := doc.StateVector()
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 3, " (guest)", nil) })
	guest := crdt.EncodeStateAsUpdateV1(doc, vector)
	snapshot, err := protocol.SealKeptTextSnapshot(keys, "notes.md", checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := protocol.SealKeptFileUpdate(keys, 0, guest)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(path, []byte(local), 0600); err != nil {
		t.Fatal(err)
	}
	read := keptTextRead{Snapshot: snapshot, Tail: 1, Entries: []keptTextEntry{{ID: 1, Body: frame}}}
	if !guestEdit {
		read = keptTextRead{Snapshot: snapshot}
	}
	state := keptTextState{Project: dir, Origin: "https://example.test", Files: []keptTextFileState{{ID: 0, Path: "notes.md", File: path, State: checkpoint, Text: base}}}
	return &keptTextHost{state: state, keys: keys, path: filepath.Join(dir, "state.json"), room: "abcdefghijklmnopqrstuv"}, read
}

func TestKeptResumeMergesLocalEditsMadeWhileAway(t *testing.T) {
	h, read := keptLocalRoom(t, "one\ntwo\nthree (host)\n", true)
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	takeInRead(t, h, read)
	got, _ := os.ReadFile(h.state.Files[0].File)
	if string(got) != "one (guest)\ntwo\nthree (host)\n" {
		t.Fatalf("edits not merged: %q", got)
	}
	if h.after != 1 {
		t.Fatalf("log not truncated after the write: %d", h.after)
	}
}

func TestKeptResumeUnchangedLocalFileBehavesAsBefore(t *testing.T) {
	h, read := keptLocalRoom(t, "one\ntwo\nthree\n", true)
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	takeInRead(t, h, read)
	got, _ := os.ReadFile(h.state.Files[0].File)
	if string(got) != "one (guest)\ntwo\nthree\n" || h.after != 1 {
		t.Fatalf("unexpected result: %q %d", got, h.after)
	}
}

func TestKeptResumeInvalidLocalFileStopsWithoutOverwriting(t *testing.T) {
	h, _ := keptLocalRoom(t, "one\n\xff\xfe\n", true)
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	if err := h.restore(); err == nil {
		t.Fatal("unmergeable local file accepted")
	}
	got, _ := os.ReadFile(h.state.Files[0].File)
	if string(got) != "one\n\xff\xfe\n" || h.after != 0 {
		t.Fatalf("file or log touched: %q %d", got, h.after)
	}
}

func TestKeptResumeUnmergeableFileDoesNotBlockOtherFiles(t *testing.T) {
	h, _ := keptLocalRoom(t, "\xff", true)
	other := filepath.Join(filepath.Dir(h.state.Files[0].File), "todo.md")
	if err := os.WriteFile(other, []byte("one\ntwo\nthree\nmine"), 0600); err != nil {
		t.Fatal(err)
	}
	h.state.Files = append(h.state.Files, keptTextFileState{ID: 1, Path: "todo.md", File: other, State: h.state.Files[0].State, Text: "one\ntwo\nthree\n"})
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	if err := h.mergeLocalEdits(); err != nil {
		t.Fatal(err)
	}
	if h.state.Files[0].Text != "one\ntwo\nthree\n" || h.state.Files[1].Text != "one\ntwo\nthree\nmine" {
		t.Fatalf("wrong files merged: %q %q", h.state.Files[0].Text, h.state.Files[1].Text)
	}
}

func TestKeptResumePublishesLocalEditsWithoutGuestEdits(t *testing.T) {
	h, read := keptLocalRoom(t, "one\ntwo\nthree (host)\n", false)
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	frame := takeInRead(t, h, read)
	_, raw, err := protocol.OpenKeptTextSnapshot(h.keys, frame)
	if err != nil {
		t.Fatal(err)
	}
	checkpointed := crdt.New()
	defer checkpointed.Destroy()
	if err := applyKeptText(checkpointed, raw); err != nil || checkpointed.GetText("content").ToString() != "one\ntwo\nthree (host)\n" {
		t.Fatalf("local edits were not in the checkpoint: %v", err)
	}
}

func TestKeptResumeRefusesLocalEditWhileWritePending(t *testing.T) {
	h, _ := keptLocalRoom(t, "one\ntwo\nthree (host)\n", true)
	pending := "one (guest)\ntwo\nthree\n"
	doc := crdt.New()
	defer doc.Destroy()
	if err := crdt.ApplyUpdateV1(doc, h.state.Files[0].State, nil); err != nil {
		t.Fatal(err)
	}
	text := doc.GetText("content")
	doc.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 3, " (guest)", nil) })
	h.state.Files[0].State, h.state.Files[0].Pending = crdt.EncodeStateAsUpdateV1(doc, nil), &pending
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	if err := h.restore(); err == nil {
		t.Fatal("ambiguous local edit merged")
	}
	if got, _ := os.ReadFile(h.state.Files[0].File); string(got) != "one\ntwo\nthree (host)\n" {
		t.Fatalf("file overwritten: %q", got)
	}
}
