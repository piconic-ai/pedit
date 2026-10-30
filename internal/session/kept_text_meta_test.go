package session

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestKeptFilesRefuseCommentSidecars(t *testing.T) {
	isolateKeptUserConfig(t)
	dir := t.TempDir()
	normal := filepath.Join(dir, "notes.md")
	os.WriteFile(normal, []byte("hello"), 0600)
	sidecar := filepath.Join(dir, ".pedit", "meta", "notes.md.json")
	os.MkdirAll(filepath.Dir(sidecar), 0700)
	os.WriteFile(sidecar, []byte("{}"), 0600)
	upper := filepath.Join(dir, ".PEDIT", "META", "x.md")
	os.MkdirAll(filepath.Dir(upper), 0700)
	os.WriteFile(upper, []byte("x"), 0600)
	opts := func(file string, more ...string) KeptTextOptions {
		return KeptTextOptions{File: file, More: more, Project: dir, Keep: time.Hour}
	}
	for name, o := range map[string]KeptTextOptions{
		"single":   opts(sidecar),
		"multiple": opts(normal, sidecar),
		"case":     opts(normal, upper),
	} {
		if _, err := prepareKeptFiles(o); err != errKeepsComments {
			t.Errorf("%s: got %v, want errKeepsComments", name, err)
		}
	}
	files, err := prepareKeptFiles(opts(normal))
	if err != nil {
		t.Fatalf("normal file refused: %v", err)
	}
	state := keptTextState{Project: dir, Files: files}
	state.Files[0].File, state.Files[0].Path = sidecar, "notes.md.json"
	h := keptTextHost{state: state}
	if err := h.openFiles(); err != errKeepsComments {
		t.Fatalf("resumed sidecar: got %v, want errKeepsComments", err)
	}
	state.Files[0].File, state.Files[0].Path = normal, "notes.md"
	h = keptTextHost{state: state}
	if err := h.openFiles(); err != nil {
		t.Fatalf("resumed normal file refused: %v", err)
	}
	h.closeFiles()
}
