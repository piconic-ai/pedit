package session

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

// mirrorLog records what OnMirrored reports.
type mirrorLog struct {
	mu   sync.Mutex
	seen map[string]error
}

func (l *mirrorLog) add(path string, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.seen == nil {
		l.seen = map[string]error{}
	}
	l.seen[path] = err
}

func (l *mirrorLog) get(path string) (error, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	err, ok := l.seen[path]
	return err, ok
}

func TestJoinMirrorsTheRoomsOtherFiles(t *testing.T) {
	f := setup(t, "# agenda\n", setupOpts{watch: true})
	spec := writeBeside(t, f, "docs/spec.md", "# spec\n")
	if _, err := f.session.AddFile(spec); err != nil {
		t.Fatal(err)
	}
	if _, err := f.session.AddFile(writeBeside(t, f, "board.canvas", `{"nodes":[],"edges":[]}`)); err != nil {
		t.Fatal(err)
	}
	var log mirrorLog
	dir := t.TempDir()
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{Directory: dir, Watch: true, OnMirrored: log.add}})
	if err != nil {
		t.Fatal(err)
	}
	copySpec := filepath.Join(dir, "docs", "spec.md")
	prototest.WaitFor(t, wait, func() bool { return readFileOr(copySpec) == "# spec\n" }, "the spec, mirrored")
	if err, ok := log.get(copySpec); !ok || err != nil {
		t.Fatalf("OnMirrored(spec) = %v, %v", err, ok)
	}
	// A canvas is for the browser.
	prototest.WaitFor(t, wait, func() bool { _, ok := log.get(filepath.Join(dir, "board.canvas")); return ok }, "the canvas, reported")
	if err, _ := log.get(filepath.Join(dir, "board.canvas")); !errors.Is(err, errNotText) {
		t.Fatalf("canvas: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "board.canvas")); !os.IsNotExist(err) {
		t.Fatalf("the canvas was written: %v", err)
	}

	// Edits go both ways, file by file.
	if err := os.WriteFile(copySpec, []byte("# spec\n- from the guest\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return readFile(t, spec) == "# spec\n- from the guest\n" }, "the guest's edit at the host")
	if readFile(t, g.File()) != "# agenda\n" || readFile(t, f.file) != "# agenda\n" {
		t.Fatalf("first file: copy %q, host %q", readFile(t, g.File()), readFile(t, f.file))
	}

	// A file the host adds later is mirrored too.
	later := writeBeside(t, f, "later.md", "later\n")
	if _, err := f.session.AddFile(later); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return readFileOr(filepath.Join(dir, "later.md")) == "later\n" }, "the later file")

	// Leaving saves every copy.
	if err := os.WriteFile(filepath.Join(dir, "later.md"), []byte("later, edited\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := g.Stop(); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return readFile(t, later) == "later, edited\n" }, "the last edit at the host")
}

func TestJoinRemovesEveryTemporaryCopy(t *testing.T) {
	f := setup(t, "a\n", setupOpts{})
	if _, err := f.session.AddFile(writeBeside(t, f, "docs/b.md", "b\n")); err != nil {
		t.Fatal(err)
	}
	var log mirrorLog
	g, err := joinFromCLI(t, f, joinCLIOpts{temporary: true, JoinOptions: JoinOptions{OnMirrored: log.add}})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(g.File())
	prototest.WaitFor(t, wait, func() bool { return readFileOr(filepath.Join(dir, "docs", "b.md")) == "b\n" }, "the second file")
	if err := g.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the temporary directory is still there: %v", err)
	}
}

// The paths come from the room: a hostile host can list any, so the guest
// checks them again and never writes over or out of its directory.
func TestMirrorRefusesWhatAHostileHostLists(t *testing.T) {
	f := setup(t, "a\n", setupOpts{})
	var log mirrorLog
	dir := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "taken.md"), []byte("mine\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{Directory: dir, OnMirrored: log.add}})
	if err != nil {
		t.Fatal(err)
	}
	g.mirrorMu.Lock()
	g.mirrorFiles([]protocol.FileEntry{
		{ID: 1, Path: "Notes.md", Format: "text"}, // the first file is notes.md
		{ID: 2, Path: "../escape.md", Format: "text"},
		{ID: 3, Path: "taken.md", Format: "text"},
		{ID: 4, Path: "link/inside.md", Format: "text"},
		{ID: 5, Path: "a", Format: "text"},
		{ID: 6, Path: "a/b.md", Format: "text"}, // "a" is a file now
		{ID: 7, Path: "c/d.md", Format: "text"},
		{ID: 8, Path: "C", Format: "text"}, // "c" is a directory now
		{ID: 9, Path: "con.md", Format: "text"},
	})
	g.mirrorMu.Unlock()
	refused := map[string]bool{}
	for _, p := range []string{"Notes.md", "../escape.md", "taken.md", "link/inside.md", "a/b.md", "C", "con.md"} {
		err, ok := log.get(filepath.Join(dir, filepath.FromSlash(p)))
		if !ok || err == nil {
			t.Errorf("%s: mirrored (%v, %v)", p, err, ok)
		}
		refused[p] = true
	}
	for _, p := range []string{"a", "c/d.md"} {
		if err, ok := log.get(filepath.Join(dir, filepath.FromSlash(p))); !ok || err != nil {
			t.Errorf("%s: not mirrored (%v, %v)", p, err, ok)
		}
	}
	if readFile(t, filepath.Join(dir, "taken.md")) != "mine\n" {
		t.Fatal("wrote over a file that was there")
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatalf("wrote out of the directory: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escape.md")); !os.IsNotExist(err) {
		t.Fatal("wrote above the directory")
	}
	// Each id is reported once.
	g.mirrorMu.Lock()
	g.mirrorFiles([]protocol.FileEntry{{ID: 5, Path: "a", Format: "text"}})
	g.mirrorMu.Unlock()
	var names []string
	log.mu.Lock()
	for p := range log.seen {
		names = append(names, p)
	}
	log.mu.Unlock()
	sort.Strings(names)
	if len(names) != 9 {
		t.Fatalf("reported %q", names)
	}
}

func TestParentKeys(t *testing.T) {
	for key, want := range map[string][]string{
		"a.md":     nil,
		"a/b.md":   {"a"},
		"a/b/c.md": {"a", "a/b"},
	} {
		got := parentKeys(key)
		if len(got) != len(want) {
			t.Fatalf("parentKeys(%q) = %q", key, got)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("parentKeys(%q) = %q", key, got)
			}
		}
	}
}

func readFileOr(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}
