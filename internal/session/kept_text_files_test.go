package session

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol"
)

func TestKeptFilesRecoverPartialWriteBeforeCheckpoint(t *testing.T) {
	keys, base, first, _ := keptFixFrames(t)
	dir := t.TempDir()
	paths := []string{filepath.Join(dir, "notes.md"), filepath.Join(dir, "todo.md")}
	for _, path := range paths {
		if err := os.WriteFile(path, []byte("base"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	state := keptTextState{Project: dir, Origin: "https://example.test", Files: []keptTextFileState{
		{ID: 0, Path: "notes.md", File: paths[0], State: base, Text: "base"},
		{ID: 1, Path: "todo.md", File: paths[1], State: base, Text: "base"},
	}}
	snapshot, err := protocol.SealKeptBundle(keys, []protocol.KeptFileSnapshot{{ID: 0, Path: "notes.md", Update: base}, {ID: 1, Path: "todo.md", Update: base}})
	if err != nil {
		t.Fatal(err)
	}
	entries := []any{}
	for i, id := range []uint32{0, 99, 1} {
		frame, err := protocol.SealKeptFileUpdate(keys, id, first)
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, map[string]any{"id": i + 1, "body": frame})
	}
	checkpoints := 0
	client := &http.Client{Transport: keepFixTransport(func(r *http.Request) (*http.Response, error) {
		var body []byte
		if r.Method == "GET" {
			body, _ = json.Marshal(map[string]any{"snapshot": snapshot, "entries": entries, "cutoff": 0, "tail": 3})
		} else {
			checkpoints++
			if r.Header.Get("X-Pedit-Cutoff") != "3" {
				t.Error("checkpoint did not advance past unknown file")
			}
			for _, path := range paths {
				raw, _ := os.ReadFile(path)
				if string(raw) != "base first" {
					t.Error("checkpoint before all durable source writes")
				}
			}
			frame, _ := io.ReadAll(r.Body)
			files, err := protocol.OpenKeptBundle(keys, frame)
			if err != nil || len(files) != 2 {
				t.Error("invalid multifile checkpoint")
			}
			body = []byte(`{"keepSeconds":60,"keepUntil":1000000000000}`)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})}
	h := keptTextHost{state: state, keys: keys, path: filepath.Join(dir, "state.json"), room: "abcdefghijklmnopqrstuv", client: client}
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	if err := h.restore(); err != nil {
		t.Fatal(err)
	}
	triggered := false
	h.files[0].bound.SetTestHook(func(step filewriter.Step) {
		if step == filewriter.StepExchanged && !triggered {
			triggered = true
			var saved keptTextState
			if err := readKeptState(h.path, &saved); err != nil || saved.Files[0].Pending == nil || saved.Files[1].Pending == nil {
				t.Error("all-file journal not durable before first exchange")
			}
			if err := os.WriteFile(paths[1], []byte("external"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	})
	if err := h.sync(context.Background()); err == nil {
		t.Fatal("second source conflict was ignored")
	}
	if !triggered || checkpoints != 0 || h.after != 0 || h.skipped != 1 {
		t.Fatalf("premature cutoff or missing unknown-ID skip: %v %d %d %d", triggered, checkpoints, h.after, h.skipped)
	}
	var saved keptTextState
	if err := readKeptState(h.path, &saved); err != nil || saved.Files[0].Pending != nil || saved.Files[1].Pending == nil {
		t.Fatal("partial-write journal lost")
	}
	h.closeFiles()
	if err := os.WriteFile(paths[1], []byte("base"), 0600); err != nil {
		t.Fatal(err)
	}
	resumed := keptTextHost{state: saved, keys: keys, path: h.path, room: h.room, client: client}
	if err := resumed.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer resumed.closeFiles()
	if err := resumed.restore(); err != nil {
		t.Fatal(err)
	}
	if err := resumed.sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if checkpoints != 1 || resumed.after != 3 {
		t.Fatal("recovery did not checkpoint exactly once")
	}
}

func TestKeptFilesPreflightPreservesAllSources(t *testing.T) {
	keys, base, _, _ := keptFixFrames(t)
	dir := t.TempDir()
	h := keptTextHost{keys: keys, path: filepath.Join(dir, "state.json"), state: keptTextState{Project: dir}}
	for i := range 2 {
		path := filepath.Join(dir, strconv.Itoa(i)+".md")
		os.WriteFile(path, []byte("base"), 0600)
		next := "after"
		h.state.Files = append(h.state.Files, keptTextFileState{ID: uint32(i), Path: filepath.Base(path), File: path, Text: "base", State: base, Pending: &next})
	}
	if err := h.openFiles(); err != nil {
		t.Fatal(err)
	}
	defer h.closeFiles()
	os.WriteFile(h.state.Files[1].File, []byte("external"), 0600)
	if err := h.finishWrites(); err == nil {
		t.Fatal("source conflict ignored")
	}
	raw, _ := os.ReadFile(h.state.Files[0].File)
	if string(raw) != "base" {
		t.Fatal("first source changed before preflight completed")
	}
}

func TestKeptFilesRejectAliasesAndOutsideProjectBeforeRoomCreation(t *testing.T) {
	isolateKeptUserConfig(t)
	dir := t.TempDir()
	first := filepath.Join(dir, "first.md")
	os.WriteFile(first, []byte("hello"), 0600)
	alias := filepath.Join(dir, "alias.md")
	if err := os.Link(first, alias); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.md")
	os.WriteFile(outside, []byte("outside"), 0600)
	calls := 0
	client := &http.Client{Transport: keepFixTransport(func(*http.Request) (*http.Response, error) { calls++; return nil, io.EOF })}
	for _, second := range []string{first, alias, outside} {
		h := keptTextHost{client: client}
		if err := h.prepare(context.Background(), KeptTextOptions{File: first, More: []string{second}, Project: dir, Server: "https://example.test", Keep: time.Hour}); err == nil {
			t.Fatal("invalid file list accepted")
		}
	}
	if calls != 0 {
		t.Fatal("created room before validating sources")
	}
}

func TestKeptFilesReadsLegacyPrivateJournal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	file := filepath.Join(t.TempDir(), "old.md")
	raw, _ := json.Marshal(map[string]any{"File": file, "State": []byte{0, 0}, "Text": "before", "Pending": "after", "Project": filepath.Dir(file), "Origin": "https://example.test", "Keep": 60})
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	var state keptTextState
	if err := readKeptState(path, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Files) != 1 || state.Files[0].ID != 0 || state.Files[0].File != file || state.Files[0].Path != "old.md" || state.Files[0].Pending == nil || *state.Files[0].Pending != "after" {
		t.Fatal("legacy journal not normalized")
	}
}
