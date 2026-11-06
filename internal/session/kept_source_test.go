package session

import (
	"context"
	"errors"
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

// leaveKeptSource shares a kept source, lets a guest in, and leaves. The
// source keeps its doc, which the session no longer feeds. It returns the
// guest's doc.
func leaveKeptSource(t *testing.T, a *awayRoom, src *testSource) *guestDoc {
	t.Helper()
	opts := a.options()
	opts.Source, opts.Keep, opts.Generation = src, time.Hour, "gen-1"
	s, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	a.waitSent(protocol.KindSnapshot, 1)
	waitForRecord(t, a)
	guest := newGuestDoc(t, s.Client.Keys(), a.sent(protocol.KindSnapshot)[0])
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	a.mu.Lock()
	a.msgs = nil
	a.mu.Unlock()
	return guest
}

func resumeOptions(a *awayRoom, src Source, generation string) Options {
	opts := a.options()
	opts.Resume, opts.Source, opts.Generation = a.id, src, generation
	opts.File, opts.Server = "", ""
	return opts
}

func TestResumeWithASourceMergesItsStateAndWritesNothingToFileZero(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	src := newTestSource("notes\n")
	guest := leaveKeptSource(t, a, src)
	before := a.record()

	// While the host was away the app edited its document (its file is not
	// written yet) and a guest wrote an entry.
	src.insert(0, "app ")
	first := guest.insert(0, "guest ")
	a.script(1, protocol.EncodeLogged(1, first), protocol.EncodeLogEnd(1))
	applied := src.appliedCount()

	s, err := Start(context.Background(), resumeOptions(a, src, "gen-1"))
	if err != nil {
		t.Fatal(err)
	}
	src.mu.Lock()
	src.session = s
	src.mu.Unlock()
	t.Cleanup(func() { _ = s.Stop() })

	// One history: each edit is in the source once, and the session's doc is the source's.
	got := src.String()
	if len(got) != len("guest app notes\n") || strings.Count(got, "guest ") != 1 || strings.Count(got, "app ") != 1 || strings.Count(got, "notes") != 1 {
		t.Fatalf("source = %q", got)
	}
	if s.Text.ToString() != got {
		t.Fatalf("session doc %q, source %q", s.Text.ToString(), got)
	}
	if src.appliedCount() == applied {
		t.Fatal("the merged doc did not reach Source.Apply")
	}
	// File 0 is the source's: never written here. The record journals the
	// merge as a write in doubt: Text is what the file holds, Pending the merge.
	if disk := readText(t, a.file); disk != "notes\n" {
		t.Fatalf("file = %q", disk)
	}
	rec := a.record()
	if rec.Files[0].Pending == nil || *rec.Files[0].Pending != got || rec.Files[0].Text != "notes\n" ||
		slices.Equal(rec.Files[0].State, before.Files[0].State) || stateText(t, rec.Files[0].State) != got {
		t.Fatalf("record file = %+v", rec.Files[0])
	}
	// The checkpoint holds the merge, and the relay's log is cut.
	checkpoints := a.sent(protocol.KindCheckpoint)
	if len(checkpoints) != 1 || bundleText(t, s.Client.Keys(), checkpoints[0][8:]) != got {
		t.Fatalf("checkpoints = %d", len(checkpoints))
	}
	prototest.WaitFor(t, wait, func() bool { return a.record().After == 1 }, "the record to follow the checkpoint")
}

func TestResumeWithASourceRefusesAnotherHistory(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	src := newTestSource("notes\n")
	leaveKeptSource(t, a, src)
	connections := len(a.relay.Conns())
	for _, generation := range []string{"", "gen-2"} {
		if s, err := Start(context.Background(), resumeOptions(a, src, generation)); err == nil {
			_ = s.Stop()
			t.Fatalf("resumed with generation %q", generation)
		}
	}
	if n := len(a.relay.Conns()); n != connections {
		t.Fatalf("%d connections before the refusal", n-connections)
	}
}

// deadSource stands for a process that dies before its document has the merge.
type deadSource struct{ *testSource }

func (deadSource) Apply([]byte) error { return errors.New("the process died") }

func TestResumeWithASourceSurvivesDyingBeforeTheSourceHasTheMerge(t *testing.T) {
	a := newAwayRoom(t, "notes\n")
	src := newTestSource("notes\n")
	guest := leaveKeptSource(t, a, src)
	first := guest.insert(0, "guest ")
	a.script(1, protocol.EncodeLogged(1, first), protocol.EncodeLogEnd(1))

	// The checkpoint is acknowledged, then the source never gets the merge.
	if s, err := Start(context.Background(), resumeOptions(a, deadSource{src}, "gen-1")); err == nil {
		_ = s.Stop()
		t.Fatal("started although the source refused the merge")
	}
	prototest.WaitFor(t, wait, func() bool { return a.record().After == 1 }, "the cursor")
	rec := a.record()
	if rec.Files[0].Pending == nil || rec.Files[0].Text != "notes\n" || stateText(t, rec.Files[0].State) != "guest notes\n" {
		t.Fatalf("record file = %+v", rec.Files[0])
	}

	// Resume again from the unchanged source with the saved cursor: the log
	// is not replayed, and the guest's edit still comes back.
	a.script(1, protocol.EncodeLogEnd(1))
	s, err := Start(context.Background(), resumeOptions(a, src, "gen-1"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Stop() })
	if got := src.String(); got != "guest notes\n" || s.Text.ToString() != got {
		t.Fatalf("source %q, session %q", got, s.Text.ToString())
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
