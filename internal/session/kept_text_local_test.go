package session

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/reearth/ygo/crdt"
)

// keptLocalRoom returns a host about to resume a kept room whose checkpoint
// holds three lines and whose log holds one guest edit to line 1, with the
// source file on disk set to local. The counter counts checkpoints that cut
// the log.
func keptLocalRoom(t *testing.T, local string) (*keptTextHost, *int) {
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
	cuts := new(int)
	client := &http.Client{Transport: keepFixTransport(func(r *http.Request) (*http.Response, error) {
		body := []byte(`{"keepSeconds":60,"keepUntil":1000000000000}`)
		if r.Method == "GET" {
			body, _ = json.Marshal(map[string]any{"snapshot": snapshot, "entries": []any{map[string]any{"id": 1, "body": frame}}, "cutoff": 0, "tail": 1})
		} else if r.Header.Get("X-Pedit-Cutoff") == "1" {
			*cuts++
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})}
	state := keptTextState{Project: dir, Origin: "https://example.test", Files: []keptTextFileState{{ID: 0, Path: "notes.md", File: path, State: checkpoint, Text: base}}}
	return &keptTextHost{state: state, keys: keys, path: filepath.Join(dir, "state.json"), room: "abcdefghijklmnopqrstuv", client: client}, cuts
}

func TestKeptResumeMergesLocalEditsMadeWhileAway(t *testing.T) {
	h, cuts := keptLocalRoom(t, "one\ntwo\nthree (host)\n")
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	if err := h.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(h.state.Files[0].File)
	if string(got) != "one (guest)\ntwo\nthree (host)\n" {
		t.Fatalf("edits not merged: %q", got)
	}
	if *cuts != 1 || h.after != 1 {
		t.Fatalf("log not truncated after the write: %d %d", *cuts, h.after)
	}
}

func TestKeptResumeUnchangedLocalFileBehavesAsBefore(t *testing.T) {
	h, cuts := keptLocalRoom(t, "one\ntwo\nthree\n")
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	if err := h.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(h.state.Files[0].File)
	if string(got) != "one (guest)\ntwo\nthree\n" || *cuts != 1 {
		t.Fatalf("unexpected result: %q %d", got, *cuts)
	}
}

func TestKeptResumeInvalidLocalFileStopsWithoutOverwriting(t *testing.T) {
	h, cuts := keptLocalRoom(t, "one\n\xff\xfe\n")
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	if err := h.restore(); err == nil {
		t.Fatal("unmergeable local file accepted")
	}
	got, _ := os.ReadFile(h.state.Files[0].File)
	if string(got) != "one\n\xff\xfe\n" || *cuts != 0 {
		t.Fatalf("file or log touched: %q %d", got, *cuts)
	}
}

func TestKeptResumeUnmergeableFileDoesNotBlockOtherFiles(t *testing.T) {
	h, _ := keptLocalRoom(t, "\xff")
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
