package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// A guest deleting the first character of a commented selection leaves the
// rest commented: the saved anchor follows the edit instead of keeping a stale one.
func TestKeptCommentsFollowAGuestDeletingAnAnchorBoundary(t *testing.T) {
	for name, withGap := range map[string]bool{"plain": false, "with an update whose dependency is missing": true} {
		t.Run(name, func(t *testing.T) { keptCommentsFollowDeletion(t, withGap) })
	}
}

func keptCommentsFollowDeletion(t *testing.T, withGap bool) {
	keys, _, _, _ := keptFixFrames(t)
	dir := t.TempDir()
	notes := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(notes, []byte("hello world"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".pedit", "meta"), 0o700); err != nil {
		t.Fatal(err)
	}
	saved, err := meta.Render(&meta.File{Path: "notes.md", Comments: map[string]meta.Thread{"t1": keptCommentThread("world", 6)}})
	if err != nil {
		t.Fatal(err)
	}
	metaName := filepath.Join(dir, ".pedit", "meta", "notes.md.json")
	if err := os.WriteFile(metaName, saved, 0o600); err != nil {
		t.Fatal(err)
	}
	files, err := prepareKeptFiles(dir, notes)
	if err != nil {
		t.Fatal(err)
	}
	guest := crdt.New()
	if err := crdt.ApplyUpdateV1(guest, files[0].State, nil); err != nil {
		t.Fatal(err)
	}
	vector := guest.StateVector()
	text := guest.GetText("content")
	guest.Transact(func(tx *crdt.Transaction) { text.Delete(tx, 6, 1) })
	frame, err := protocol.SealKeptFileUpdate(keys, 0, crdt.EncodeStateAsUpdateV1(guest, vector))
	if err != nil {
		t.Fatal(err)
	}
	entries := []keptTextEntry{{ID: 1, Body: frame}}
	if withGap {
		// Only the second of two edits arrives: it needs the first, which is
		// not in the log, so the batch is pruned and rebuilt.
		vector = guest.StateVector()
		guest.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 0, "a", nil) })
		vector = guest.StateVector()
		guest.Transact(func(tx *crdt.Transaction) { text.Insert(tx, 1, "b", nil) })
		gap, err := protocol.SealKeptFileUpdate(keys, 0, crdt.EncodeStateAsUpdateV1(guest, vector))
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, keptTextEntry{ID: 2, Body: gap})
	}
	host := &keptTextHost{state: keptTextState{Project: dir, Files: files}, keys: keys, path: filepath.Join(t.TempDir(), "state.json"), room: "abcdefghijklmnopqrstuv"}
	if err := host.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer host.closeFiles()
	if err := host.restore(); err != nil {
		t.Fatal(err)
	}
	snapshot, err := host.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	takeInRead(t, host, keptTextRead{Snapshot: snapshot, Entries: entries, Tail: uint64(len(entries))})
	if withGap && host.skipped != 1 {
		t.Fatalf("the update with a missing dependency was not pruned: skipped %d", host.skipped)
	}
	written, _ := os.ReadFile(metaName)
	parsed, err := meta.Parse(written)
	if err != nil || parsed.Comments["t1"].Anchor.Text == nil || parsed.Comments["t1"].Anchor.Text.Exact != "orld" {
		t.Fatalf("anchor did not follow the deletion: %s (%v)", written, err)
	}
}
