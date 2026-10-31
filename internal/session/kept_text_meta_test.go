package session

import (
	"os"
	"path/filepath"
	"testing"
)

// A saved record that lists a file of .pedit/meta/ is refused when it is opened.
func TestKeptFilesRefuseCommentSidecars(t *testing.T) {
	isolateKeptUserConfig(t)
	dir := t.TempDir()
	normal := filepath.Join(dir, "notes.md")
	os.WriteFile(normal, []byte("hello"), 0600)
	sidecar := filepath.Join(dir, ".pedit", "meta", "notes.md.json")
	os.MkdirAll(filepath.Dir(sidecar), 0700)
	os.WriteFile(sidecar, []byte("{}"), 0600)
	files, err := prepareKeptFiles(dir, normal)
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
