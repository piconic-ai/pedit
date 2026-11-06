package session

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// startKeptSource shares a source in a kept room, as pedit serve does.
func startKeptSource(t *testing.T, a *awayRoom, text string) (*Session, *testSource) {
	t.Helper()
	src := newTestSource(text)
	opts := a.options()
	opts.Source, opts.Keep = src, time.Hour
	opts.Generation, opts.Origins = "gen-1", []string{"https://cms.example.com"}
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	src.mu.Lock()
	src.session = s
	src.mu.Unlock()
	t.Cleanup(func() { _ = s.Stop() })
	return s, src
}

func stateText(t *testing.T, state []byte) string {
	t.Helper()
	doc := crdt.New()
	if err := crdt.ApplyUpdateV1(doc, state, nil); err != nil {
		t.Fatal(err)
	}
	return doc.GetText("content").ToString()
}

func waitForRecord(t *testing.T, a *awayRoom) {
	t.Helper()
	prototest.WaitFor(t, wait, func() bool { _, err := os.Stat(keptTestStatePath(t, a.project, a.id)); return err == nil }, "the record")
}

func TestAKeptSourceRoomWritesARecordThatChecksAgainstTheFile(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	s, src := startKeptSource(t, a, "notes\n")
	a.waitSent(protocol.KindSnapshot, 1)
	waitForRecord(t, a)
	rec := a.record()
	if rec.Generation != "gen-1" || !slices.Equal(rec.Origins, []string{"https://cms.example.com"}) || !rec.Socket || !rec.Initialized {
		t.Fatalf("record = %+v", rec)
	}
	if len(rec.Files) != 1 || rec.Files[0].File != a.file || rec.Files[0].Text != "notes\n" || stateText(t, rec.Files[0].State) != "notes\n" {
		t.Fatalf("record = %+v", rec)
	}

	// The source writes the file after its edit; the next record checks against it.
	src.insert(0, "a ")
	prototest.WaitFor(t, wait, func() bool { return s.Text.ToString() == "a notes\n" }, "the edit in the room's doc")
	if err := os.WriteFile(a.file, []byte("a notes\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.away.saveRecord(false); err != nil {
		t.Fatal(err)
	}
	rec = a.record()
	if rec.Files[0].Text != "a notes\n" || stateText(t, rec.Files[0].State) != "a notes\n" {
		t.Fatalf("record = %+v", rec)
	}
}

func TestAKeptSourceRecordKeepsTheLastStateTheFileMatches(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	s, src := startKeptSource(t, a, "notes\n")
	waitForRecord(t, a)

	// The source has not written its edit yet: the file is behind the doc.
	src.insert(0, "a ")
	prototest.WaitFor(t, wait, func() bool { return s.Text.ToString() == "a notes\n" }, "the edit in the room's doc")
	if err := s.away.saveRecord(false); err != nil {
		t.Fatal(err)
	}
	rec := a.record()
	if rec.Files[0].Text != "notes\n" || stateText(t, rec.Files[0].State) != "notes\n" {
		t.Fatalf("record = %+v", rec)
	}
	// Leaving sends a snapshot with the edit; the record still holds a state
	// that the file matches.
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	rec = a.record()
	if rec.Files[0].Text != "notes\n" || stateText(t, rec.Files[0].State) != "notes\n" || rec.Until == 0 {
		t.Fatalf("record = %+v", rec)
	}
	last := a.sent(protocol.KindSnapshot)
	if got := bundleText(t, s.Client.Keys(), last[len(last)-1]); got != "a notes\n" {
		t.Fatalf("last snapshot holds %q", got)
	}
}

func TestAKeptSourceRoomWithoutAMatchingFileWritesNoRecordYet(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	// The file differs from the source's doc when the room starts.
	if err := os.WriteFile(a.file, []byte("other\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	startKeptSource(t, a, "notes\n")
	a.waitSent(protocol.KindSnapshot, 1)
	time.Sleep(50 * time.Millisecond)
	if _, err := os.Stat(keptTestStatePath(t, a.project, a.id)); !os.IsNotExist(err) {
		t.Fatalf("a record without a state to check: %v", err)
	}
}

func TestAKeptSourceRoomCannotBeResumedYet(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	opts := a.options()
	opts.Source, opts.Resume = newTestSource("notes\n"), "0123456789012345678901"
	if _, err := Start(context.Background(), opts); err == nil {
		t.Fatal("started a source with Resume")
	}
}

func TestServeFieldsAreWrittenOnlyWhenSetAndOlderRecordsStillLoad(t *testing.T) {
	s := newCommentEntryScene(t)
	path := filepath.Join(t.TempDir(), "state.json")
	state := s.state
	state.Generation, state.Origins = "gen-1", []string{"https://cms.example.com"}
	if err := saveKeptState(path, state); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"Generation":"gen-1"`) || !strings.Contains(string(raw), `"Origins":["https://cms.example.com"]`) {
		t.Fatalf("record lacks the fields: %s", raw)
	}
	var got keptTextState
	if err := readKeptState(path, &got); err != nil || got.Generation != "gen-1" || len(got.Origins) != 1 {
		t.Fatalf("read %+v, %v", got, err)
	}
	// A record `pedit <file>` wrote has neither, so an older pedit, which
	// decodes strictly, refuses only the records that have them.
	if err := saveKeptState(path, s.state); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	if strings.Contains(string(raw), `"Generation"`) || strings.Contains(string(raw), `"Origins"`) {
		t.Fatalf("a record of pedit <file> carries the fields: %s", raw)
	}
	got = keptTextState{}
	if err := readKeptState(path, &got); err != nil || got.Generation != "" || got.Origins != nil {
		t.Fatalf("read %+v, %v", got, err)
	}
}
