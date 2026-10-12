package filewriter

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"
)

// saveStyle is how an editor writes the file.
type saveStyle int

const (
	// renameSave writes a new file and renames it over the old one.
	renameSave saveStyle = iota
	// inPlaceSave truncates the file and writes it.
	inPlaceSave
)

// editorSave saves content to path as an editor would. It reports a failure
// with t.Error, not t.Fatal, so it is safe to call from any goroutine.
func editorSave(t testing.TB, path string, style saveStyle, content string) {
	t.Helper()
	switch style {
	case renameSave:
		swap := filepath.Join(filepath.Dir(path), "editor-swap")
		if err := os.WriteFile(swap, []byte(content), 0o640); err != nil {
			t.Error(err)
			return
		}
		if err := os.Chmod(swap, 0o640); err != nil {
			t.Error(err)
			return
		}
		if err := os.Rename(swap, path); err != nil {
			t.Error(err)
		}
	case inPlaceSave:
		if err := os.WriteFile(path, []byte(content), 0o640); err != nil {
			t.Error(err)
		}
	}
}

func stat(t testing.TB, path string) os.FileInfo {
	t.Helper()
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

// errno is an error as a failed rename returns it.
func errno(op string, e syscall.Errno) error {
	return &os.LinkError{Op: op, Old: "old", New: "new", Err: e}
}

// requireExchange skips the test where exchanging two files is not
// implemented. On Linux and macOS a temporary directory that cannot do it is
// a failure, so the tests do not silently stop covering it; PEDIT_NO_EXCHANGE=1
// skips them for such a file system.
func requireExchange(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("exchanging files is implemented for Linux and macOS")
	}
	if os.Getenv("PEDIT_NO_EXCHANGE") == "1" {
		t.Skip("PEDIT_NO_EXCHANGE=1")
	}
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, name := range []string{"a", "b"} {
		if err := root.WriteFile(name, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := exchange(root, "a", "b"); errors.Is(err, errUnsupported) {
		t.Fatalf("the temporary directory cannot exchange files; set PEDIT_NO_EXCHANGE=1 to skip the tests that need it")
	} else if err != nil {
		t.Fatal(err)
	}
}

// afterExchange are the points a save can land at once the file is in place.
var afterExchange = []struct {
	name string
	step Step
}{
	{"right after the exchange", StepExchanged},
	{"while rechecking", StepRechecking},
}

type hookKey struct {
	step Step
	n    int
}

// raceFixture is a Writer on a file in a fresh directory, whose test hook lets
// the test act as an editor at exact points of a write.
type raceFixture struct {
	t     *testing.T
	path  string
	bound *BoundFile
	w     *Writer

	hooks   map[hookKey]func()
	reached map[Step]int
	// errs are what OnError got, changed how often OnExternalChange was called.
	errs    []error
	changed int
}

func newRace(t *testing.T, initial string) *raceFixture {
	t.Helper()
	path := setup(t, initial)
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}
	bound, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bound.Close() })
	r := &raceFixture{t: t, path: path, bound: bound, hooks: map[hookKey]func(){}, reached: map[Step]int{}}
	r.w = New(path, initial, Options{
		Bound:            bound,
		Delay:            time.Hour,
		OnError:          func(err error) { r.errs = append(r.errs, err) },
		OnExternalChange: func() { r.changed++ },
	})
	bound.SetTestHook(func(s Step) {
		r.reached[s]++
		if fn := r.hooks[hookKey{s, r.reached[s]}]; fn != nil {
			fn()
		}
	})
	return r
}

// at runs fn the nth time (from 1) a write reaches step.
func (r *raceFixture) at(step Step, n int, fn func()) {
	r.hooks[hookKey{step, n}] = fn
}

// flush writes c through the Writer.
func (r *raceFixture) flush(c string) error {
	r.w.Schedule(c)
	return r.w.Flush()
}

func (r *raceFixture) onDisk() string {
	r.t.Helper()
	b, err := os.ReadFile(r.path)
	if err != nil {
		r.t.Fatal(err)
	}
	return string(b)
}

// leftovers lists the temporary files in the directory.
func (r *raceFixture) leftovers() []string {
	r.t.Helper()
	entries, err := os.ReadDir(filepath.Dir(r.path))
	if err != nil {
		r.t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".pedit-") && strings.HasSuffix(e.Name(), ".tmp") {
			names = append(names, e.Name())
		}
	}
	return names
}

func (r *raceFixture) noLeftovers() {
	r.t.Helper()
	if left := r.leftovers(); len(left) != 0 {
		r.t.Fatalf("temporary files left behind: %v", left)
	}
}

// kept checks the outcome when a save made while pedit wrote is put back: the
// write is skipped with a bare ErrExternalChange and nothing is printed, the
// Writer still has base as the content it wrote, and the file holds save. If
// editorsInfo is not nil, it is the editor's own file that came back, with its
// bytes, mode and modification time.
func (r *raceFixture) kept(t *testing.T, err error, base, save string, editorsInfo os.FileInfo) {
	t.Helper()
	if err != ErrExternalChange {
		t.Fatalf("Flush = %v, want ErrExternalChange", err)
	}
	if len(r.errs) != 0 || r.changed != 1 {
		t.Fatalf("errors = %v, external changes = %d", r.errs, r.changed)
	}
	if got := r.onDisk(); got != save {
		t.Fatalf("file = %q, want the save %q", got, save)
	}
	if got := r.w.LastWritten(); got != base {
		t.Fatalf("LastWritten = %q, want %q", got, base)
	}
	if editorsInfo != nil {
		now := stat(t, r.path)
		if !os.SameFile(editorsInfo, now) || now.Mode() != editorsInfo.Mode() || !now.ModTime().Equal(editorsInfo.ModTime()) {
			t.Fatalf("the editor's file is not back as it was: %v %v, was %v %v", now.Mode(), now.ModTime(), editorsInfo.Mode(), editorsInfo.ModTime())
		}
	}
	r.noLeftovers()
}

func TestExchangeErrors(t *testing.T) {
	requireExchange(t)
	root, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	write := func(name, content string) {
		t.Helper()
		if err := root.WriteFile(name, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	read := func(name string) string {
		t.Helper()
		b, err := root.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}

	write("a", "A")
	if err := exchange(root, "a", "missing"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("exchange with a missing name = %v", err)
	}
	write("b", "B")
	if err := renameNoReplace(root, "a", "b"); !errors.Is(err, os.ErrExist) {
		t.Fatalf("renameNoReplace onto a file = %v", err)
	}
	if read("a") != "A" || read("b") != "B" {
		t.Fatal("a refused rename changed a file")
	}
	if err := renameNoReplace(root, "a", "c"); err != nil {
		t.Fatalf("renameNoReplace onto a new name = %v", err)
	}
	if _, err := root.Lstat("a"); !errors.Is(err, os.ErrNotExist) || read("c") != "A" {
		t.Fatal("renameNoReplace did not move the file")
	}
	if err := exchange(root, "b", "c"); err != nil {
		t.Fatalf("exchange = %v", err)
	}
	if read("b") != "A" || read("c") != "B" {
		t.Fatalf("exchange left b = %q, c = %q", read("b"), read("c"))
	}
}

func TestWriteKeepsASaveThatLandsBeforeTheExchange(t *testing.T) {
	requireExchange(t)
	// The table is built outside t.Run, so each save takes the t of the subtest
	// that calls it; a failure then ends that subtest, not the parent test.
	tests := []struct {
		name string
		save func(t *testing.T, r *raceFixture)
		want string
	}{
		{"renamed over the file", func(t *testing.T, r *raceFixture) { editorSave(t, r.path, renameSave, "editor rename") }, "editor rename"},
		{"written in place", func(t *testing.T, r *raceFixture) { editorSave(t, r.path, inPlaceSave, "editor in place") }, "editor in place"},
		{"deleted and created", func(t *testing.T, r *raceFixture) {
			if err := os.Remove(r.path); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(r.path, []byte("editor created"), 0o640); err != nil {
				t.Fatal(err)
			}
		}, "editor created"},
		{"emptied", func(t *testing.T, r *raceFixture) { editorSave(t, r.path, inPlaceSave, "") }, ""},
	}
	// Between the write of the temporary file and the exchange, there are two
	// points the save can land at.
	before := []struct {
		name string
		step Step
	}{
		{"after the temporary file is written", StepTempWritten},
		{"just before the exchange", StepBeforeReplace},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, at := range before {
				t.Run(at.name, func(t *testing.T) {
					r := newRace(t, "v0")
					var editors os.FileInfo
					r.at(at.step, 1, func() {
						tt.save(t, r)
						editors = stat(t, r.path)
					})
					err := r.flush("pedit")
					if editors == nil {
						t.Fatal("the editor never saved")
					}
					r.kept(t, err, "v0", tt.want, editors)
				})
			}
		})
	}
}

func TestWriteKeepsALateWriteIntoTheFileItReplaced(t *testing.T) {
	requireExchange(t)
	// With an empty file, the truncation is invisible, so the second read is
	// the only thing that can tell the late write from the file pedit expected.
	for _, tt := range []struct{ name, base string }{
		{"a file with text", "v0"},
		{"an empty file", ""},
	} {
		base := tt.base
		t.Run(tt.name, func(t *testing.T) {
			r := newRace(t, base)
			var editor *os.File
			var editors os.FileInfo
			// The editor opened the file just before pedit moved it, and writes a
			// moment later, after pedit read it back and found what it expected.
			r.at(StepBeforeReplace, 1, func() {
				f, err := os.OpenFile(r.path, os.O_WRONLY, 0)
				if err != nil {
					t.Fatal(err)
				}
				editor = f
			})
			r.at(StepRechecking, 1, func() {
				defer editor.Close()
				if err := editor.Truncate(0); err != nil {
					t.Fatal(err)
				}
				if _, err := editor.WriteAt([]byte("late save"), 0); err != nil {
					t.Fatal(err)
				}
				var err error
				if editors, err = editor.Stat(); err != nil {
					t.Fatal(err)
				}
			})
			err := r.flush("pedit")
			if editor == nil || editors == nil {
				t.Fatal("the editor never wrote")
			}
			r.kept(t, err, base, "late save", editors)
		})
	}
}

func TestWriteKeepsAnInPlaceSaveThatFinishesAfterTheExchange(t *testing.T) {
	requireExchange(t)
	r := newRace(t, "v0")
	var editor *os.File
	var editors os.FileInfo
	// The truncation lands before the exchange and the write after it.
	r.at(StepBeforeReplace, 1, func() {
		f, err := os.OpenFile(r.path, os.O_WRONLY|os.O_TRUNC, 0)
		if err != nil {
			t.Fatal(err)
		}
		editor = f
	})
	r.at(StepExchanged, 1, func() {
		defer editor.Close()
		if _, err := editor.WriteString("in place save"); err != nil {
			t.Fatal(err)
		}
		var err error
		if editors, err = editor.Stat(); err != nil {
			t.Fatal(err)
		}
	})
	err := r.flush("pedit")
	if editors == nil {
		t.Fatal("the editor never wrote")
	}
	r.kept(t, err, "v0", "in place save", editors)
}

func TestWriteLeavesASaveAfterTheExchangeToTheWatcher(t *testing.T) {
	requireExchange(t)
	for _, at := range afterExchange {
		step := at.step
		t.Run(at.name, func(t *testing.T) {
			r := newRace(t, "v0")
			r.at(step, 1, func() { editorSave(t, r.path, renameSave, "save") })
			if err := r.flush("pedit"); err != nil {
				t.Fatal(err)
			}
			// The save is on the new file's name now: the watcher merges it
			// against what pedit wrote.
			if got := r.onDisk(); got != "save" {
				t.Fatalf("file = %q", got)
			}
			if got := r.w.LastWritten(); got != "pedit" {
				t.Fatalf("LastWritten = %q", got)
			}
			if len(r.errs) != 0 || r.changed != 0 {
				t.Fatalf("errors = %v, external changes = %d", r.errs, r.changed)
			}
			r.noLeftovers()
		})
	}
}

func TestWritePutsBackTheNewestOfSeveralSaves(t *testing.T) {
	requireExchange(t)
	r := newRace(t, "v0")
	var editors os.FileInfo
	r.at(StepBeforeReplace, 1, func() { editorSave(t, r.path, renameSave, "save 1") })
	// A second save lands while pedit puts the first one back.
	r.at(StepExchanged, 1, func() {
		editorSave(t, r.path, renameSave, "save 2")
		editors = stat(t, r.path)
	})
	err := r.flush("pedit")
	r.kept(t, err, "v0", "save 2", editors)
}

func TestWriteKeepsASaveWrittenIntoItsNewFile(t *testing.T) {
	requireExchange(t)
	for _, at := range afterExchange {
		step := at.step
		t.Run(at.name, func(t *testing.T) {
			r := newRace(t, "v0")
			var pedits os.FileInfo
			r.at(step, 1, func() {
				pedits = stat(t, r.path)
				editorSave(t, r.path, inPlaceSave, "save")
			})
			if err := r.flush("pedit"); err != nil {
				t.Fatal(err)
			}
			if got := r.onDisk(); got != "save" {
				t.Fatalf("file = %q", got)
			}
			if !os.SameFile(pedits, stat(t, r.path)) {
				t.Fatal("the save did not land in pedit's file")
			}
			if got := r.w.LastWritten(); got != "pedit" {
				t.Fatalf("LastWritten = %q", got)
			}
			if len(r.errs) != 0 || r.changed != 0 {
				t.Fatalf("errors = %v, external changes = %d", r.errs, r.changed)
			}
			r.noLeftovers()
		})
	}

	// A rename save lands before the exchange and is swapped back, and an
	// in-place save then lands in pedit's file before the swap. Restoring finds
	// pedit's own inode under the temporary name, now holding the editor's
	// text, so only its content says that it is not what pedit wrote: the
	// save is the file, not the rename save that came before it. "EDITS" is as
	// long as "pedit"; with restoreTime the modification time is put back as
	// well, so neither size nor time can tell them apart.
	for _, tt := range []struct {
		name        string
		restoreTime bool
	}{
		{"while an earlier save is put back", false},
		{"with the same size and modification time", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := newRace(t, "v0")
			r.at(StepBeforeReplace, 1, func() { editorSave(t, r.path, renameSave, "first") })
			r.at(StepExchanged, 1, func() {
				pedits := stat(t, r.path)
				editorSave(t, r.path, inPlaceSave, "EDITS")
				if tt.restoreTime {
					if err := os.Chtimes(r.path, pedits.ModTime(), pedits.ModTime()); err != nil {
						t.Error(err)
					}
				}
			})
			r.kept(t, r.flush("pedit"), "v0", "EDITS", nil)
		})
	}
}

func TestWriteKeepsTheNewestSaveWhenSavesNeverStop(t *testing.T) {
	requireExchange(t)
	r := newRace(t, "v0")
	saves := 0
	save := func() {
		saves++
		editorSave(t, r.path, renameSave, fmt.Sprintf("save %d", saves))
	}
	for n := 1; n <= 10; n++ {
		r.at(StepBeforeReplace, n, save)
		r.at(StepExchanged, n, save)
	}
	err := r.flush("pedit")
	if !errors.Is(err, ErrExternalChange) {
		t.Fatalf("Flush = %v", err)
	}
	if len(r.errs) != 1 || r.changed != 1 {
		t.Fatalf("errors = %v, external changes = %d", r.errs, r.changed)
	}
	left := r.leftovers()
	if len(left) != 1 || !strings.Contains(err.Error(), left[0]) {
		t.Fatalf("leftovers = %v, error = %v", left, err)
	}
	var kept *KeptError
	if !errors.As(err, &kept) || kept.Name != left[0] {
		t.Fatalf("error = %#v, want a KeptError for %s", err, left[0])
	}
	saved, rerr := os.ReadFile(filepath.Join(filepath.Dir(r.path), left[0]))
	if rerr != nil {
		t.Fatal(rerr)
	}
	// The newest save is under the name; the one before it is kept aside.
	if string(saved) != "save 4" || r.onDisk() != "save 5" {
		t.Fatalf("kept aside %q, file %q", saved, r.onDisk())
	}
	if got := r.w.LastWritten(); got != "v0" {
		t.Fatalf("LastWritten = %q", got)
	}
}

func TestWriteKeepsASaveItCannotPutBack(t *testing.T) {
	requireExchange(t)
	r := newRace(t, "v0")
	exchanged := r.bound.calls.exchange
	calls := 0
	r.bound.calls.exchange = func(root *os.Root, a, b string) error {
		calls++
		if calls > 1 {
			return errno("renameat2", syscall.EIO)
		}
		return exchanged(root, a, b)
	}
	r.at(StepBeforeReplace, 1, func() { editorSave(t, r.path, renameSave, "editor") })
	err := r.flush("pedit")
	if !errors.Is(err, ErrExternalChange) || !errors.Is(err, syscall.EIO) {
		t.Fatalf("Flush = %v", err)
	}
	if len(r.errs) != 1 || r.changed != 1 {
		t.Fatalf("errors = %v, external changes = %d", r.errs, r.changed)
	}
	left := r.leftovers()
	if len(left) != 1 || !strings.Contains(err.Error(), filepath.Join(filepath.Dir(r.path), left[0])) {
		t.Fatalf("leftovers = %v, error = %v", left, err)
	}
	var kept *KeptError
	if !errors.As(err, &kept) || kept.Name != left[0] {
		t.Fatalf("error = %#v, want a KeptError for %s", err, left[0])
	}
	saved, rerr := os.ReadFile(filepath.Join(filepath.Dir(r.path), left[0]))
	if rerr != nil {
		t.Fatal(rerr)
	}
	if string(saved) != "editor" {
		t.Fatalf("kept aside %q", saved)
	}
	// pedit's content is in place, so it is not merged in again.
	if r.onDisk() != "pedit" || r.w.LastWritten() != "pedit" {
		t.Fatalf("file %q, LastWritten %q", r.onDisk(), r.w.LastWritten())
	}
}

func TestWriteKeepsASaveItCannotCheckAfterPuttingItBack(t *testing.T) {
	requireExchange(t)
	r := newRace(t, "v0")
	r.at(StepBeforeReplace, 1, func() { editorSave(t, r.path, renameSave, "editor") })
	// The second exchange puts the editor's save back and pedit's file is under
	// the temporary name; it vanishes before pedit can look at it.
	var gone string
	r.at(StepExchanged, 2, func() {
		left := r.leftovers()
		if len(left) != 1 {
			t.Fatalf("leftovers = %v", left)
		}
		gone = left[0]
		if err := os.Remove(filepath.Join(filepath.Dir(r.path), gone)); err != nil {
			t.Fatal(err)
		}
	})
	err := r.flush("pedit")
	var kept *KeptError
	if !errors.As(err, &kept) || kept.Name != gone || !errors.Is(err, ErrExternalChange) || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Flush = %#v, want a KeptError for %s that matches ErrExternalChange and os.ErrNotExist", err, gone)
	}
	want := "file changed outside pedit: cannot check what pedit moved aside from a.md; it is kept in " + filepath.Join(filepath.Dir(r.path), gone) + ": "
	if !strings.HasPrefix(err.Error(), want) {
		t.Fatalf("error = %q, want it to start with %q", err, want)
	}
	if len(r.errs) != 1 || r.changed != 1 {
		t.Fatalf("errors = %v, external changes = %d", r.errs, r.changed)
	}
	// The editor's save is back in place, and pedit's content never landed.
	if r.onDisk() != "editor" || r.w.LastWritten() != "v0" {
		t.Fatalf("file %q, LastWritten %q", r.onDisk(), r.w.LastWritten())
	}
}

func TestWriteKeepsWhatItCannotCheck(t *testing.T) {
	requireExchange(t)
	// The old file vanishes from under its temporary name, as when it cannot
	// be read; pedit's content is in place all the same.
	for _, at := range afterExchange {
		step := at.step
		t.Run(at.name, func(t *testing.T) {
			r := newRace(t, "v0")
			r.at(step, 1, func() {
				left := r.leftovers()
				if len(left) != 1 {
					t.Fatalf("leftovers = %v", left)
				}
				if err := os.Remove(filepath.Join(filepath.Dir(r.path), left[0])); err != nil {
					t.Fatal(err)
				}
			})
			err := r.flush("pedit")
			var landed landedError
			var kept *KeptError
			if !errors.As(err, &landed) || !errors.As(err, &kept) || errors.Is(err, ErrExternalChange) {
				t.Fatalf("Flush = %#v", err)
			}
			if !strings.HasPrefix(kept.Name, ".pedit-") || !strings.HasSuffix(kept.Name, ".tmp") {
				t.Fatalf("Name = %q", kept.Name)
			}
			want := "cannot check what pedit replaced in a.md; it is kept in " + filepath.Join(filepath.Dir(r.path), kept.Name) + ": "
			if !strings.HasPrefix(err.Error(), want) {
				t.Fatalf("error = %q, want it to start with %q", err, want)
			}
			if len(r.errs) != 1 || r.changed != 0 {
				t.Fatalf("errors = %v, external changes = %d", r.errs, r.changed)
			}
			if r.onDisk() != "pedit" || r.w.LastWritten() != "pedit" {
				t.Fatalf("file %q, LastWritten %q", r.onDisk(), r.w.LastWritten())
			}
		})
	}
}

func TestWriteRefusesWhatIsPlantedBeforeTheExchange(t *testing.T) {
	for _, kind := range []string{"symlink", "directory"} {
		t.Run(kind, func(t *testing.T) {
			if kind == "symlink" && runtime.GOOS == "windows" {
				t.Skip("symlink creation needs privileges on Windows")
			}
			r := newRace(t, "v0")
			secret := filepath.Join(t.TempDir(), "secret")
			if err := os.WriteFile(secret, []byte("private"), 0o600); err != nil {
				t.Fatal(err)
			}
			r.at(StepBeforeReplace, 1, func() {
				if err := os.Remove(r.path); err != nil {
					t.Fatal(err)
				}
				var err error
				if kind == "symlink" {
					err = os.Symlink(secret, r.path)
				} else {
					err = os.Mkdir(r.path, 0o755)
				}
				if err != nil {
					t.Fatal(err)
				}
			})
			err := r.flush("pedit")
			if err == nil || err.Error() != "shared file a.md is not a regular file" {
				t.Fatalf("Flush = %v", err)
			}
			if stat(t, r.path).Mode().IsRegular() {
				t.Fatal("the planted entry was replaced")
			}
			if b, err := os.ReadFile(secret); err != nil || string(b) != "private" {
				t.Fatalf("secret = %q, %v", b, err)
			}
			r.noLeftovers()
		})
	}
}

// A file that appears while pedit creates the missing one stays, whichever way
// the file system lets create keep the name from being replaced.
func TestWriteDoesNotReplaceAFileCreatedMeanwhile(t *testing.T) {
	// The table is built outside t.Run, so setup takes the t of the subtest that
	// calls it; a failure then ends that subtest, not the parent test.
	tests := []struct {
		name  string
		setup func(t *testing.T, c *fsCalls)
	}{
		{"exclusive rename", func(t *testing.T, c *fsCalls) {}},
		{"hard link", func(t *testing.T, c *fsCalls) {
			c.noReplace = func(*os.Root, string, string) error { return errUnsupported }
		}},
		{"lstat then rename", func(t *testing.T, c *fsCalls) {
			c.noReplace = func(*os.Root, string, string) error { return errUnsupported }
			c.link = func(*os.Root, string, string) error { return errUnsupported }
			c.rename = func(*os.Root, string, string) error {
				t.Error("renamed over a file that appeared")
				return nil
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRace(t, "v0")
			if err := os.Remove(r.path); err != nil {
				t.Fatal(err)
			}
			tt.setup(t, &r.bound.calls)
			r.at(StepBeforeReplace, 1, func() {
				if err := os.WriteFile(r.path, []byte("editor"), 0o640); err != nil {
					t.Fatal(err)
				}
			})
			err := r.flush("pedit")
			if err != ErrExternalChange || r.changed != 1 || len(r.errs) != 0 {
				t.Fatalf("Flush = %v, errors = %v, external changes = %d", err, r.errs, r.changed)
			}
			if got := r.onDisk(); got != "editor" {
				t.Fatalf("file = %q", got)
			}
			if got := r.w.LastWritten(); got != "v0" {
				t.Fatalf("LastWritten = %q", got)
			}
			r.noLeftovers()
		})
	}
}

// A file that appears at a missing name is not pedit's to replace, even when
// pedit would take it for the expected one: an empty file holds "", and one
// pedit cannot read counts as holding anything.
func TestWriteDoesNotReplaceAnEmptyOrUnreadableFileCreatedMeanwhile(t *testing.T) {
	tests := []struct {
		name       string
		step       Step
		expected   string
		unreadable bool
	}{
		{"empty, between the two looks at the name", StepTempWritten, "", false},
		{"empty, just before the file is created", StepBeforeReplace, "", false},
		{"unreadable, just before the file is created", StepBeforeReplace, "v0", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.unreadable && (runtime.GOOS == "windows" || os.Geteuid() == 0) {
				t.Skip("mode 0 keeps nobody out on Windows or from root")
			}
			r := newRace(t, "v0")
			if err := os.Remove(r.path); err != nil {
				t.Fatal(err)
			}
			// The descriptor stays open, so a late write through it shows
			// which file the name holds after Write.
			var someone *os.File
			var planted os.FileInfo
			t.Cleanup(func() {
				if someone != nil {
					_ = someone.Close()
				}
			})
			r.at(tt.step, 1, func() {
				f, err := os.OpenFile(r.path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
				if err != nil {
					t.Fatal(err)
				}
				someone = f
				if tt.unreadable {
					if _, err := f.WriteString("v0"); err != nil {
						t.Fatal(err)
					}
					if err := f.Chmod(0); err != nil {
						t.Fatal(err)
					}
				}
				planted = stat(t, r.path)
			})
			err := r.bound.Write(tt.expected, "pedit")
			if planted == nil {
				t.Fatal("the file was never created")
			}
			if err != ErrExternalChange {
				t.Fatalf("Write = %v, want ErrExternalChange", err)
			}
			if now := stat(t, r.path); !os.SameFile(planted, now) || now.Size() != planted.Size() {
				t.Fatalf("the name no longer holds the file created meanwhile: size %d, was %d", now.Size(), planted.Size())
			}
			if !tt.unreadable {
				if _, err := someone.WriteString("someone\n"); err != nil {
					t.Fatal(err)
				}
				if got := r.onDisk(); got != "someone\n" {
					t.Fatalf("file = %q", got)
				}
			}
			r.noLeftovers()
		})
	}
}

// A copy pedit has yet to create takes no file that is there, however empty or
// open to others: the file would keep its mode and get the document's text.
func TestWriteCreateOnlyRefusesAnExistingFile(t *testing.T) {
	r := newRace(t, "")
	if err := os.Chmod(r.path, 0o666); err != nil {
		t.Fatal(err)
	}
	before := stat(t, r.path)
	r.bound.CreateOnly()
	if err := r.bound.Write("", "pedit"); err != ErrExternalChange {
		t.Fatalf("Write onto a file = %v, want ErrExternalChange", err)
	}
	now := stat(t, r.path)
	if !os.SameFile(before, now) || now.Size() != 0 || r.onDisk() != "" {
		t.Fatalf("the file was replaced: size %d, content %q", now.Size(), r.onDisk())
	}
	if runtime.GOOS != "windows" && now.Mode().Perm() != 0o666 {
		t.Fatalf("mode = %v", now.Mode().Perm())
	}
	r.noLeftovers()

	if err := os.Remove(r.path); err != nil {
		t.Fatal(err)
	}
	if err := r.bound.Write("", "one"); err != nil {
		t.Fatal(err)
	}
	if got := r.onDisk(); got != "one" {
		t.Fatalf("file = %q", got)
	}
	if runtime.GOOS != "windows" {
		if got := stat(t, r.path).Mode().Perm(); got != 0o600 {
			t.Fatalf("mode = %v", got)
		}
	}
	// Creating the file ended the restriction: later writes replace it.
	if err := r.bound.Write("one", "two"); err != nil {
		t.Fatal(err)
	}
	if got := r.onDisk(); got != "two" {
		t.Fatalf("file = %q", got)
	}
	r.noLeftovers()
}

func TestWriteCreatesAMissingFile(t *testing.T) {
	tests := []struct {
		name  string
		setup func(c *fsCalls)
		used  func(linked, renamed int) bool
	}{
		{"exclusive rename", func(c *fsCalls) {}, func(linked, renamed int) bool {
			// Where the platform has a rename that refuses to replace, create uses
			// it and reaches neither the link nor the plain rename.
			if runtime.GOOS != "linux" && runtime.GOOS != "darwin" || os.Getenv("PEDIT_NO_EXCHANGE") == "1" {
				return true
			}
			return linked == 0 && renamed == 0
		}},
		{"hard link", func(c *fsCalls) {
			c.noReplace = func(*os.Root, string, string) error { return errUnsupported }
		}, func(linked, renamed int) bool { return linked == 1 && renamed == 0 }},
		{"lstat then rename", func(c *fsCalls) {
			c.noReplace = func(*os.Root, string, string) error { return errUnsupported }
			c.link = func(*os.Root, string, string) error { return errUnsupported }
		}, func(linked, renamed int) bool { return renamed == 1 }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newRace(t, "v0")
			if err := os.Remove(r.path); err != nil {
				t.Fatal(err)
			}
			tt.setup(&r.bound.calls)
			linked, renamed := 0, 0
			link, rename := r.bound.calls.link, r.bound.calls.rename
			r.bound.calls.link = func(root *os.Root, a, b string) error { linked++; return link(root, a, b) }
			r.bound.calls.rename = func(root *os.Root, a, b string) error { renamed++; return rename(root, a, b) }
			if err := r.bound.Write("", "pedit"); err != nil {
				t.Fatal(err)
			}
			if tt.used != nil && !tt.used(linked, renamed) {
				t.Fatalf("linked %d times, renamed %d times", linked, renamed)
			}
			if got := r.onDisk(); got != "pedit" {
				t.Fatalf("file = %q", got)
			}
			if runtime.GOOS != "windows" {
				if got := stat(t, r.path).Mode().Perm(); got != 0o600 {
					t.Fatalf("mode = %v", got)
				}
			}
			r.noLeftovers()
		})
	}
}

func TestWriteCreatesAgainAFileDeletedWhileItWrites(t *testing.T) {
	r := newRace(t, "v0")
	r.at(StepBeforeReplace, 1, func() {
		if err := os.Remove(r.path); err != nil {
			t.Fatal(err)
		}
	})
	if err := r.flush("pedit"); err != nil {
		t.Fatal(err)
	}
	if got := r.onDisk(); got != "pedit" || r.w.LastWritten() != "pedit" {
		t.Fatalf("file %q, LastWritten %q", got, r.w.LastWritten())
	}
	r.noLeftovers()
}

func TestWriteReportsItsTemporaryFileGone(t *testing.T) {
	for _, exists := range []bool{true, false} {
		t.Run(fmt.Sprintf("file exists=%v", exists), func(t *testing.T) {
			r := newRace(t, "v0")
			if !exists {
				if err := os.Remove(r.path); err != nil {
					t.Fatal(err)
				}
			}
			r.at(StepBeforeReplace, 1, func() {
				left := r.leftovers()
				if len(left) != 1 {
					t.Fatalf("leftovers = %v", left)
				}
				if err := os.Remove(filepath.Join(filepath.Dir(r.path), left[0])); err != nil {
					t.Fatal(err)
				}
			})
			err := r.flush("pedit")
			// A missing temporary file is an error of its own, not a change
			// made outside pedit to merge.
			if !errors.Is(err, os.ErrNotExist) || errors.Is(err, ErrExternalChange) {
				t.Fatalf("Flush = %v", err)
			}
			if len(r.errs) != 1 || r.changed != 0 {
				t.Fatalf("errors = %v, external changes = %d", r.errs, r.changed)
			}
			if got := r.w.LastWritten(); got != "v0" {
				t.Fatalf("LastWritten = %q", got)
			}
			if _, err := os.Lstat(r.path); exists != (err == nil) {
				t.Fatalf("file exists = %v after the write", err == nil)
			}
			if exists && r.onDisk() != "v0" {
				t.Fatalf("file = %q", r.onDisk())
			}
			r.noLeftovers()
		})
	}
}

func TestWriteDoesNotReplaceAFileCreatedAfterItWasDeleted(t *testing.T) {
	r := newRace(t, "v0")
	// A stub, not the platform's exchange, so this runs on every platform: the
	// real one finding no file is covered by TestExchangeErrors.
	r.bound.calls.exchange = func(_ *os.Root, a, b string) error {
		// The editor deletes the file, so the exchange finds nothing under the
		// name, and creates it again before pedit does.
		if err := os.Remove(r.path); err != nil {
			t.Error(err)
		}
		if err := os.WriteFile(r.path, []byte("editor"), 0o640); err != nil {
			t.Error(err)
		}
		return &os.LinkError{Op: "renameat2", Old: a, New: b, Err: os.ErrNotExist}
	}
	err := r.flush("pedit")
	if err != ErrExternalChange || r.changed != 1 || len(r.errs) != 0 {
		t.Fatalf("Flush = %v, errors = %v, external changes = %d", err, r.errs, r.changed)
	}
	if got := r.onDisk(); got != "editor" {
		t.Fatalf("file = %q", got)
	}
	if got := r.w.LastWritten(); got != "v0" {
		t.Fatalf("LastWritten = %q", got)
	}
	r.noLeftovers()
}

func TestWriteFallsBackForOneWriteOnAnUnexpectedError(t *testing.T) {
	for _, e := range []syscall.Errno{syscall.EPERM, syscall.EIO} {
		t.Run(e.Error(), func(t *testing.T) {
			r := newRace(t, "v0")
			exchanged, renamed := r.bound.calls.exchange, r.bound.calls.rename
			exchanges, renames := 0, 0
			r.bound.calls.exchange = func(root *os.Root, a, b string) error {
				exchanges++
				if exchanges == 1 {
					return errno("renameat2", e)
				}
				return exchanged(root, a, b)
			}
			r.bound.calls.rename = func(root *os.Root, a, b string) error { renames++; return renamed(root, a, b) }
			if err := r.flush("one"); err != nil {
				t.Fatal(err)
			}
			if got := r.onDisk(); got != "one" || renames != 1 {
				t.Fatalf("file %q after %d renames", got, renames)
			}
			if r.bound.noExchange.Load() {
				t.Fatal("gave up exchanging for the session")
			}
			if err := r.flush("two"); err != nil {
				t.Fatal(err)
			}
			if got := r.onDisk(); got != "two" || exchanges != 2 {
				t.Fatalf("file %q after %d exchanges", got, exchanges)
			}
		})
	}
	t.Run("unsupported", func(t *testing.T) {
		r := newRace(t, "v0")
		exchanges := 0
		r.bound.calls.exchange = func(*os.Root, string, string) error {
			exchanges++
			return errUnsupported
		}
		for _, content := range []string{"one", "two"} {
			if err := r.flush(content); err != nil {
				t.Fatal(err)
			}
			if got := r.onDisk(); got != content {
				t.Fatalf("file = %q", got)
			}
		}
		if !r.bound.noExchange.Load() || exchanges != 1 {
			t.Fatalf("noExchange = %v after %d exchanges", r.bound.noExchange.Load(), exchanges)
		}
	})
}

func TestWriteWithoutExchangeChecksAgainBeforeRenaming(t *testing.T) {
	// The table is built outside t.Run, so each save takes the t of the subtest
	// that calls it; a failure then ends that subtest, not the parent test.
	tests := []struct {
		name string
		save func(t *testing.T, r *raceFixture)
		want string
		// heldOpen marks a save that replaces the file pedit holds open.
		heldOpen bool
	}{
		{"renamed over the file", func(t *testing.T, r *raceFixture) { editorSave(t, r.path, renameSave, "editor rename") }, "editor rename", true},
		{"written in place", func(t *testing.T, r *raceFixture) { editorSave(t, r.path, inPlaceSave, "editor in place") }, "editor in place", false},
		{"deleted and created", func(t *testing.T, r *raceFixture) {
			if err := os.Remove(r.path); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(r.path, []byte("v0"), 0o640); err != nil {
				t.Fatal(err)
			}
		}, "v0", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.heldOpen && runtime.GOOS == "windows" {
				// The share mode is not the problem (os.Root opens with
				// FILE_SHARE_DELETE), but renaming over a file that is open
				// has not been tried on Windows.
				t.Skip("renaming over a file pedit holds open is unverified on Windows")
			}
			r := newRace(t, "v0")
			r.bound.noExchange.Store(true)
			var editors os.FileInfo
			r.at(StepBeforeReplace, 1, func() {
				tt.save(t, r)
				editors = stat(t, r.path)
			})
			err := r.flush("pedit")
			r.kept(t, err, "v0", tt.want, editors)
		})
	}

	t.Run("changed before the check", func(t *testing.T) {
		r := newRace(t, "v0")
		r.bound.noExchange.Store(true)
		editorSave(t, r.path, renameSave, "editor")
		editors := stat(t, r.path)
		if err := r.bound.Write("v0", "pedit"); err != ErrExternalChange {
			t.Fatalf("Write = %v", err)
		}
		if got := r.onDisk(); got != "editor" || !os.SameFile(editors, stat(t, r.path)) {
			t.Fatalf("file = %q", got)
		}
		r.noLeftovers()
	})
	t.Run("deleted", func(t *testing.T) {
		r := newRace(t, "v0")
		r.bound.noExchange.Store(true)
		r.at(StepBeforeReplace, 1, func() {
			if err := os.Remove(r.path); err != nil {
				t.Fatal(err)
			}
		})
		if err := r.flush("pedit"); err != nil {
			t.Fatal(err)
		}
		if got := r.onDisk(); got != "pedit" {
			t.Fatalf("file = %q", got)
		}
		r.noLeftovers()
	})
	t.Run("planted", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlink creation needs privileges on Windows")
		}
		r := newRace(t, "v0")
		r.bound.noExchange.Store(true)
		secret := filepath.Join(t.TempDir(), "secret")
		if err := os.WriteFile(secret, []byte("private"), 0o600); err != nil {
			t.Fatal(err)
		}
		r.at(StepBeforeReplace, 1, func() {
			if err := os.Remove(r.path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(secret, r.path); err != nil {
				t.Fatal(err)
			}
		})
		err := r.flush("pedit")
		if err == nil || err.Error() != "shared file a.md is not a regular file" {
			t.Fatalf("Flush = %v", err)
		}
		if stat(t, r.path).Mode().IsRegular() {
			t.Fatal("the planted link was replaced")
		}
		r.noLeftovers()
	})
}

func TestWriteWithoutExchangeRenamesAgainWithoutTheFileOpen(t *testing.T) {
	t.Run("the second rename works", func(t *testing.T) {
		r := newRace(t, "v0")
		r.bound.noExchange.Store(true)
		renamed := r.bound.calls.rename
		renames := 0
		r.bound.calls.rename = func(root *os.Root, a, b string) error {
			renames++
			if renames == 1 {
				return errno("rename", syscall.EACCES)
			}
			return renamed(root, a, b)
		}
		if err := r.flush("pedit"); err != nil {
			t.Fatal(err)
		}
		if renames != 2 || r.onDisk() != "pedit" {
			t.Fatalf("file %q after %d renames", r.onDisk(), renames)
		}
		// Without the file open there is nothing to read again.
		if r.reached[StepRechecking] != 0 {
			t.Fatal("checked the replaced file after the retry")
		}
		r.noLeftovers()
	})
	t.Run("both fail", func(t *testing.T) {
		r := newRace(t, "v0")
		r.bound.noExchange.Store(true)
		renames := 0
		r.bound.calls.rename = func(*os.Root, string, string) error {
			renames++
			return errno("rename", syscall.EACCES)
		}
		err := r.flush("pedit")
		if !errors.Is(err, syscall.EACCES) || renames != 2 {
			t.Fatalf("Flush = %v after %d renames", err, renames)
		}
		if got := r.onDisk(); got != "v0" || len(r.errs) != 1 {
			t.Fatalf("file %q, errors = %v", got, r.errs)
		}
		r.noLeftovers()
	})
}

func TestWriteWithoutExchangeReportsALateWriteItReplaced(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("an open file cannot be replaced or written through a second handle")
	}
	r := newRace(t, "v0")
	r.bound.noExchange.Store(true)
	var editor *os.File
	r.at(StepBeforeReplace, 1, func() {
		f, err := os.OpenFile(r.path, os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		editor = f
	})
	// The editor writes into the file pedit just replaced, then saves again.
	r.at(StepRechecking, 1, func() {
		if _, err := editor.WriteAt([]byte("editor"), 0); err != nil {
			t.Error(err)
		}
		if err := editor.Close(); err != nil {
			t.Error(err)
		}
		editorSave(t, r.path, renameSave, "later")
	})
	err := r.flush("pedit")
	if !errors.Is(err, ErrSaveOverwritten) || errors.Is(err, ErrExternalChange) {
		t.Fatalf("Flush = %v", err)
	}
	if len(r.errs) != 1 || r.changed != 0 {
		t.Fatalf("errors = %v, external changes = %d", r.errs, r.changed)
	}
	if got := r.onDisk(); got != "later" {
		t.Fatalf("file = %q", got)
	}
	if got := r.w.LastWritten(); got != "pedit" {
		t.Fatalf("LastWritten = %q", got)
	}
	r.noLeftovers()
}

// A file pedit cannot read counts as holding what it expected: there is nothing
// to compare, and refusing to write would leave the file unsaved for good.
func TestWriteTreatsAnUnreadableFileAsHoldingWhatItExpected(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a file mode does not make a file unreadable on Windows")
	}
	for _, withoutExchange := range []bool{false, true} {
		t.Run(fmt.Sprintf("without exchange=%v", withoutExchange), func(t *testing.T) {
			if !withoutExchange {
				requireExchange(t)
			}
			r := newRace(t, "v0")
			r.bound.noExchange.Store(withoutExchange)
			// Write-only: pedit sees the file but cannot open it for reading.
			if err := os.Chmod(r.path, 0o200); err != nil {
				t.Fatal(err)
			}
			// Probe instead of checking the user ID: root without its DAC
			// capabilities is refused too, and should run this test.
			if f, err := os.Open(r.path); err == nil {
				_ = f.Close()
				t.Skip("this user reads files whatever their mode")
			}
			// "other" is not what the file holds, but pedit cannot tell.
			if err := r.bound.Write("other", "pedit"); err != nil {
				t.Fatalf("Write = %v", err)
			}
			if got := stat(t, r.path).Mode().Perm(); got != 0o200 {
				t.Fatalf("mode = %v", got)
			}
			if err := os.Chmod(r.path, 0o600); err != nil {
				t.Fatal(err)
			}
			if got := r.onDisk(); got != "pedit" {
				t.Fatalf("file = %q", got)
			}
			r.noLeftovers()
		})
	}
}

func TestWriteKeepsPermissions(t *testing.T) {
	for _, withoutExchange := range []bool{false, true} {
		t.Run(fmt.Sprintf("without exchange=%v", withoutExchange), func(t *testing.T) {
			r := newRace(t, "v0")
			r.bound.noExchange.Store(withoutExchange)
			before := stat(t, r.path).Mode()
			if err := r.flush("pedit"); err != nil {
				t.Fatal(err)
			}
			if got := stat(t, r.path).Mode(); got != before {
				t.Fatalf("mode = %v, was %v", got, before)
			}
			if runtime.GOOS != "windows" && before.Perm() != 0o640 {
				t.Fatalf("test setup: mode = %v", before)
			}
		})
	}
}
