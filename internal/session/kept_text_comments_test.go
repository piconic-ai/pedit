package session

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/piconic-ai/pedit/internal/meta"
	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

func keptCommentThread(exact string, offset int) meta.Thread {
	return meta.Thread{
		Anchor:   meta.Anchor{Type: meta.AnchorText, Text: &meta.Selector{Exact: exact, Offset: offset}},
		Quote:    exact,
		Messages: map[string]meta.Message{"m1": {Author: "Ada", Time: "2026-10-21T00:00:00Z", Body: "Which " + exact + "?"}},
	}
}

// A kept room gives each text file a comments doc of its own, loaded from
// .pedit/meta/<path>.json; a guest's thread logged while the host is away is
// written back there on resume, and the text file stays the text.
func TestKeptCommentsAreKeptAndWrittenOnResume(t *testing.T) {
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
	// A key a newer pedit wrote survives the host's writes.
	withExtra := strings.Replace(string(saved), "\n}\n", ",\n  \"future\": [1]\n}\n", 1)
	metaName := filepath.Join(dir, ".pedit", "meta", "notes.md.json")
	if err := os.WriteFile(metaName, []byte(withExtra), 0o600); err != nil {
		t.Fatal(err)
	}

	files, err := prepareKeptFiles(KeptTextOptions{File: notes, Project: dir})
	if err != nil {
		t.Fatal(err)
	}
	m := files[0].Meta
	if m == nil || m.ID != keptMetaIDBase || m.Name != ".pedit/meta/notes.md.json" {
		t.Fatalf("no paired comments doc: %+v", m)
	}
	loaded := crdt.New()
	if err := applyKeptDoc(loaded, m.State, protocol.KeptCommentsRoot); err != nil || len(loaded.GetMap("comments").Keys()) != 1 {
		t.Fatalf("saved thread not loaded into the doc: %v", err)
	}

	// The guest, with the snapshot's docs, adds a thread on "hello".
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
	threadUpdate := crdt.EncodeStateAsUpdateV1(guestMeta, vector)

	state := keptTextState{Project: dir, Origin: "https://example.test", Files: files}
	h := keptTextHost{state: state, keys: keys, path: filepath.Join(t.TempDir(), "state.json"), room: "abcdefghijklmnopqrstuv"}
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	snapshot, err := h.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := protocol.OpenKeptBundle(keys, snapshot)
	if err != nil || len(bundle) != 2 || bundle[1].ID != m.ID || bundle[1].Path != protocol.MetaPath("notes.md") {
		t.Fatalf("snapshot does not pair the comments doc: %+v %v", bundle, err)
	}
	h.closeFiles()

	entry := func(id uint32, update []byte) map[string]any {
		frame, err := protocol.SealKeptFileUpdate(keys, id, update)
		if err != nil {
			t.Fatal(err)
		}
		return map[string]any{"id": 0, "body": frame}
	}
	entries := []any{entry(m.ID, threadUpdate), entry(77, threadUpdate), entry(0, threadUpdate)}
	for i, e := range entries {
		e.(map[string]any)["id"] = i + 1
	}
	client := &http.Client{Transport: keepFixTransport(func(r *http.Request) (*http.Response, error) {
		body := []byte(`{"keepSeconds":60,"keepUntil":1000000000000}`)
		if r.Method == "GET" {
			body, _ = json.Marshal(map[string]any{"snapshot": snapshot, "entries": entries, "cutoff": 0, "tail": 3})
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})}
	statePath := filepath.Join(t.TempDir(), "state.json")
	resume := func(state keptTextState) *keptTextHost {
		host := &keptTextHost{state: state, keys: keys, path: statePath, room: "abcdefghijklmnopqrstuv", client: client}
		if err := host.openFiles(); err != nil {
			t.Fatal(err)
		}
		if err := host.restore(); err != nil {
			t.Fatal(err)
		}
		return host
	}
	host := resume(state)
	if err := host.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	// An unknown file ID, and a comments update for a text file, are skipped and counted.
	if host.skipped != 2 {
		t.Fatalf("skipped %d, want 2", host.skipped)
	}
	written, err := os.ReadFile(metaName)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := meta.Parse(written)
	if err != nil || len(parsed.Comments) != 2 || parsed.Comments["t2"].Anchor.Text == nil || parsed.Comments["t2"].Anchor.Text.Exact != "hello" || !strings.Contains(string(written), `"future": [1]`) {
		t.Fatalf("metadata file after resume: %s (%v)", written, err)
	}
	if text, _ := os.ReadFile(notes); string(text) != "hello world" {
		t.Fatalf("comments reached the shared file: %q", text)
	}
	host.closeFiles()

	// Replaying the same log changes nothing.
	var after keptTextState
	if err := readKeptState(statePath, &after); err != nil {
		t.Fatal(err)
	}
	again := resume(after)
	defer again.closeFiles()
	if err := again.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	replayed, _ := os.ReadFile(metaName)
	if !bytes.Equal(replayed, written) {
		t.Fatalf("replay changed the metadata file:\n%s\n%s", written, replayed)
	}
}

func TestKeptCommentsCreateOnlyWithAThreadAndNeverForOutsideFiles(t *testing.T) {
	dir, outside := t.TempDir(), t.TempDir()
	inside, away := filepath.Join(dir, "a.md"), filepath.Join(outside, "b.md")
	for _, name := range []string{inside, away} {
		if err := os.WriteFile(name, []byte("text"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	files, err := prepareKeptFiles(KeptTextOptions{File: inside, Project: dir})
	if err != nil || files[0].Meta == nil {
		t.Fatalf("file in the project has no comments doc: %v", err)
	}
	h := keptTextHost{state: keptTextState{Project: dir, Files: files}, files: map[uint32]*keptTextDocument{}}
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	pending, err := h.metaPending(&h.state.Files[0])
	if err != nil || pending != nil {
		t.Fatalf("a metadata file without a thread would be created: %v %v", pending, err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".pedit")); !os.IsNotExist(err) {
		t.Fatal("pedit made .pedit/meta without a thread")
	}
	outFiles, err := prepareKeptFiles(KeptTextOptions{File: away, Project: dir})
	if err != nil || outFiles[0].Meta != nil {
		t.Fatalf("file outside the project got a comments doc: %v", err)
	}
}
