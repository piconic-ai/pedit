package session

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sync"
	"testing"

	"github.com/piconic-ai/pedit/internal/protocol"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
)

// mirrorLog records what OnMirrored reports, by the path the host lists.
type mirrorLog struct {
	mu   sync.Mutex
	seen map[string]mirrored
}

type mirrored struct {
	path string
	err  error
}

func (l *mirrorLog) add(hostPath, path string, err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.seen == nil {
		l.seen = map[string]mirrored{}
	}
	l.seen[hostPath] = mirrored{path, err}
}

func (l *mirrorLog) get(hostPath string) (mirrored, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	m, ok := l.seen[hostPath]
	return m, ok
}

func (l *mirrorLog) count() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.seen)
}

func TestJoinKeepsTheLatestManifestBeforeMirroring(t *testing.T) {
	previous := runtime.GOMAXPROCS(1)
	t.Cleanup(func() { runtime.GOMAXPROCS(previous) })
	var log mirrorLog
	s := &Session{mirror: &mirror{
		opts: JoinOptions{OnMirrored: log.add},
		done: map[uint64]bool{},
	}}
	files := []protocol.FileEntry{
		{ID: 1, Path: "first.canvas", Format: protocol.FormatCanvas},
		{ID: 2, Path: "second.canvas", Format: protocol.FormatCanvas},
	}
	s.mirrorMu.Lock()
	s.takeManifest(files[:1])
	s.takeManifest(files)
	s.mirrorMu.Unlock()
	runtime.Gosched()
	runtime.Gosched()

	s.mirrorMu.Lock()
	s.startMirror()
	s.mirrorMu.Unlock()
	for _, entry := range files {
		m, ok := log.get(entry.Path)
		if !ok || !errors.Is(m.err, errNotText) {
			t.Errorf("OnMirrored(%s) = %+v, %v", entry.Path, m, ok)
		}
	}
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
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{dir: dir, Watch: true, OnMirrored: log.add}})
	if err != nil {
		t.Fatal(err)
	}
	if g.File() != filepath.Join(dir, "00-notes.md") {
		t.Fatalf("first copy at %s", g.File())
	}
	copySpec := filepath.Join(dir, "01-docs-spec.md")
	prototest.WaitFor(t, wait, func() bool { return readFileOr(copySpec) == "# spec\n" }, "the spec, mirrored")
	if m, ok := log.get("docs/spec.md"); !ok || m.err != nil || m.path != copySpec {
		t.Fatalf("OnMirrored(docs/spec.md) = %+v, %v", m, ok)
	}
	// A canvas is for the browser.
	prototest.WaitFor(t, wait, func() bool { _, ok := log.get("board.canvas"); return ok }, "the canvas, reported")
	if m, _ := log.get("board.canvas"); !errors.Is(m.err, errNotText) {
		t.Fatalf("canvas: %+v", m)
	}
	if _, err := os.Stat(filepath.Join(dir, "02-board.txt")); !os.IsNotExist(err) {
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
	copyLater := filepath.Join(dir, "03-later.md")
	prototest.WaitFor(t, wait, func() bool { return readFileOr(copyLater) == "later\n" }, "the later file")

	// Leaving saves every copy.
	if err := os.WriteFile(copyLater, []byte("later, edited\n"), 0o600); err != nil {
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
	prototest.WaitFor(t, wait, func() bool { return readFileOr(filepath.Join(dir, "01-docs-b.md")) == "b\n" }, "the second file")
	if err := g.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the temporary directory is still there: %v", err)
	}
}

// Anyone in the room can send a list of its files, so the paths in it are
// only labels: whatever they say, the copies are plain files with plain names
// in the copies' directory, and no directory is made.
func TestMirrorNamesWhatAHostileListNames(t *testing.T) {
	f := setup(t, "a\n", setupOpts{})
	var log mirrorLog
	dir := t.TempDir()
	outside := t.TempDir()
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{dir: dir, OnMirrored: log.add}})
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Symlink(outside, filepath.Join(dir, "link")); err != nil {
			t.Fatal(err)
		}
	}
	// Made while in the room, at the name a copy would take.
	if err := os.WriteFile(filepath.Join(dir, "12-taken.md"), []byte("mine\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	hostile := []protocol.FileEntry{
		{ID: 1, Path: ".git/HEAD", Format: "text"},
		{ID: 2, Path: ".git/config", Format: "text"},
		{ID: 3, Path: ".git/objects/x", Format: "text"},
		{ID: 4, Path: "GIT~1/config", Format: "text"},
		{ID: 5, Path: ".hg/hgrc", Format: "text"},
		{ID: 6, Path: ".pedit/config.yaml", Format: "text"},
		{ID: 7, Path: "desktop.ini", Format: "text"},
		{ID: 8, Path: "a.scf", Format: "text"},
		{ID: 9, Path: "notes.md.bat", Format: "text"},
		{ID: 10, Path: "../escape.md", Format: "text"},
		{ID: 11, Path: "link/inside.md", Format: "text"},
		{ID: 12, Path: "taken.md", Format: "text"},
		{ID: protocol.MaxFileID + 1, Path: "big.md", Format: "text"},
	}
	g.mirrorMu.Lock()
	g.mirrorFiles(hostile)
	g.mirrorMu.Unlock()

	if m, _ := log.get("taken.md"); !errors.As(m.err, new(*ErrFileExists)) {
		t.Fatalf("taken.md: %+v", m)
	}
	if readFile(t, filepath.Join(dir, "12-taken.md")) != "mine\n" {
		t.Fatal("wrote over a file that was there")
	}
	if m, _ := log.get("big.md"); !errors.Is(m.err, errBadID) {
		t.Fatalf("big.md: %+v", m)
	}
	plain := regexp.MustCompile(`^[0-9]{2,}(-[A-Za-z0-9]+)*\.(md|txt|yaml)$`)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() == "link" {
			continue
		}
		if !e.Type().IsRegular() || !plain.MatchString(e.Name()) {
			t.Errorf("made %s (%v)", e.Name(), e.Type())
		}
	}
	for _, name := range []string{"01-git-HEAD.txt", "02-git-config.txt", "03-git-objects-x.txt", "04-GIT-1-config.txt",
		"05-hg-hgrc.txt", "06-pedit-config.yaml", "07-desktop.txt", "08-a.txt", "09-notes-md.txt", "10-escape.md", "11-link-inside.md"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("wrote out of the directory: %v", entries)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dir), "escape.md")); !os.IsNotExist(err) {
		t.Fatal("wrote above the directory")
	}
	// Each id is reported once.
	g.mirrorMu.Lock()
	g.mirrorFiles([]protocol.FileEntry{{ID: 2, Path: "again.md", Format: "text"}})
	g.mirrorMu.Unlock()
	if n := log.count(); n != len(hostile) {
		t.Fatalf("reported %d files", n)
	}
}

// The copies' directory is held open from the join on: renamed, with a link
// to elsewhere put at its old name, the copies still go into it.
func TestMirrorStaysInTheDirectoryItJoined(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privileges on Windows")
	}
	f := setup(t, "a\n", setupOpts{})
	var log mirrorLog
	base := t.TempDir()
	dir := filepath.Join(base, "guest")
	outside := t.TempDir()
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	g, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{dir: dir, OnMirrored: log.add}})
	if err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(base, "moved")
	if err := os.Rename(dir, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, dir); err != nil {
		t.Fatal(err)
	}
	g.mirrorMu.Lock()
	g.mirrorFiles([]protocol.FileEntry{
		{ID: 1, Path: "later.md", Format: "text"},
		{ID: 2, Path: "docs/spec.md", Format: "text"},
	})
	g.mirrorMu.Unlock()
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("wrote out of the directory: %v", entries)
	}
	for _, name := range []string{"01-later.md", "02-docs-spec.md"} {
		if _, err := os.Lstat(filepath.Join(moved, name)); err != nil {
			t.Errorf("%s: not in the directory joined: %v", name, err)
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
