package session

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/piconic-ai/pedit/internal/filewriter"
	"github.com/piconic-ai/pedit/internal/protocol/prototest"
	"github.com/reearth/ygo/crdt"
)

// needsExchange skips the test where pedit swaps files to save, and so puts a
// save made meanwhile back. On Linux and macOS a temporary directory that
// cannot do it is a failure; PEDIT_NO_EXCHANGE=1 skips the tests for such a
// file system.
func needsExchange(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("exchanging files is implemented for Linux and macOS")
	}
	if os.Getenv("PEDIT_NO_EXCHANGE") == "1" {
		t.Skip("PEDIT_NO_EXCHANGE=1")
	}
	path := filepath.Join(t.TempDir(), "probe")
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	bound, err := filewriter.OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	defer bound.Close()
	exchanged := false
	bound.SetTestHook(func(s filewriter.Step) { exchanged = exchanged || s == filewriter.StepExchanged })
	if err := bound.Write("x", "y"); err != nil {
		t.Fatal(err)
	}
	if !exchanged {
		t.Fatal("the temporary directory cannot exchange files; set PEDIT_NO_EXCHANGE=1 to skip the tests that need it")
	}
}

// saveAs saves content to path as an editor does. With rename it writes a new
// file beside path and renames it over the old one; without, it writes path in
// place. It returns the first error and never touches a test, so it is safe to
// call from any goroutine, such as a timer's, and the caller decides how to
// report a failure.
func saveAs(path, content string, rename bool) error {
	if !rename {
		return os.WriteFile(path, []byte(content), 0o644)
	}
	swap := filepath.Join(filepath.Dir(path), "editor-swap")
	if err := os.WriteFile(swap, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(swap, path)
}

// saveWhileWriting returns a write hook that runs save, once, just before the
// write-th write (counting from 1) puts the file in place.
func saveWhileWriting(write int, save func()) func(filewriter.Step) {
	var writes atomic.Int32
	var landed atomic.Bool
	return func(s filewriter.Step) {
		switch s {
		case filewriter.StepTempWritten:
			writes.Add(1)
		case filewriter.StepBeforeReplace:
			if int(writes.Load()) == write && landed.CompareAndSwap(false, true) {
				save()
			}
		}
	}
}

// writeLateWhileWriting returns a write hook for an editor that opened the file
// just before the first write put it in place, and writes it in place a
// moment later, after pedit read the replaced file back.
func writeLateWhileWriting(t testing.TB, path, content string) func(filewriter.Step) {
	var editor *os.File
	done := false
	return func(s filewriter.Step) {
		switch {
		case s == filewriter.StepBeforeReplace && editor == nil && !done:
			f, err := os.OpenFile(path, os.O_WRONLY, 0)
			if err != nil {
				t.Error(err)
				return
			}
			editor = f
		case s == filewriter.StepRechecking && editor != nil:
			done = true
			if err := editor.Truncate(0); err != nil {
				t.Error(err)
			}
			if _, err := editor.WriteAt([]byte(content), 0); err != nil {
				t.Error(err)
			}
			if err := editor.Close(); err != nil {
				t.Error(err)
			}
			editor = nil
		}
	}
}

// noTempLeft fails the test if a write left its temporary file in dir. It
// waits a little first: the file a write replaced sits under the temporary
// name for a few milliseconds, until pedit has read it twice.
func noTempLeft(t testing.TB, dir string) {
	t.Helper()
	var left []string
	for deadline := time.Now().Add(wait); ; time.Sleep(5 * time.Millisecond) {
		var err error
		if left, err = filepath.Glob(filepath.Join(dir, ".pedit-*.tmp")); err != nil {
			t.Fatal(err)
		}
		if len(left) == 0 || time.Now().After(deadline) {
			break
		}
	}
	if len(left) != 0 {
		t.Errorf("temporary files left behind: %v", left)
	}
}

func TestMergesASaveThatLandsWhilePeditWrites(t *testing.T) {
	const base = "one\ntwo\n"
	const merged = "zero\none\ntwo\nthree\n"
	const editorsFile = "one\ntwo\nthree\n"
	tests := []struct {
		name string
		hook func(t *testing.T, f *fixture) func(filewriter.Step)
		// exchange is whether the save lands only where files are exchanged.
		exchange bool
	}{
		{"renamed over the file", func(t *testing.T, f *fixture) func(filewriter.Step) {
			return saveWhileWriting(1, func() {
				if err := saveAs(f.file, editorsFile, true); err != nil {
					t.Error(err)
				}
			})
		}, false},
		{"written in place", func(t *testing.T, f *fixture) func(filewriter.Step) {
			return saveWhileWriting(1, func() {
				if err := saveAs(f.file, editorsFile, false); err != nil {
					t.Error(err)
				}
			})
		}, false},
		{"written in place a moment later", func(t *testing.T, f *fixture) func(filewriter.Step) {
			return writeLateWhileWriting(t, f.file, editorsFile)
		}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.exchange {
				needsExchange(t)
			}
			// Not watching: the skipped write is what brings the save in.
			f := setup(t, base, setupOpts{})
			g := joinAsGuest(t, f.relay, f.session.URL)
			prototest.WaitFor(t, wait, func() bool { return g.String() == base }, "guest to sync")
			f.session.bound.SetTestHook(tt.hook(t, f))
			g.insert(0, "zero\n")
			prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == merged }, "the merged file")
			prototest.WaitFor(t, wait, func() bool { return g.String() == merged }, "the guest to get the save")
			noTempLeft(t, filepath.Dir(f.file))
		})
	}
}

func TestStopMergesASaveThatLandsDuringItsFirstWrite(t *testing.T) {
	f := setup(t, "one\ntwo\n", setupOpts{writeDelay: time.Minute})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "one\ntwo\n" }, "guest to sync")
	g.insert(0, "zero\n")
	prototest.WaitFor(t, wait, func() bool { return f.session.Text.ToString() == "zero\none\ntwo\n" }, "host to see the edit")
	f.session.bound.SetTestHook(saveWhileWriting(1, func() {
		if err := saveAs(f.file, "one\ntwo\nthree\n", true); err != nil {
			t.Error(err)
		}
	}))
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != "zero\none\ntwo\nthree\n" {
		t.Fatalf("content = %q", got)
	}
	noTempLeft(t, filepath.Dir(f.file))
}

func TestStopMergesASaveThatLandsDuringItsFinalWrite(t *testing.T) {
	f := setup(t, "one\ntwo\n", setupOpts{writeDelay: time.Minute})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "one\ntwo\n" }, "guest to sync")
	g.insert(0, "zero\n")
	prototest.WaitFor(t, wait, func() bool { return f.session.Text.ToString() == "zero\none\ntwo\n" }, "host to see the edit")
	// The first write goes through. An edit that arrived while leaving makes
	// the final one a write too, and the save lands in that.
	f.session.bound.SetTestHook(saveWhileWriting(2, func() {
		if err := saveAs(f.file, "zero\none\ntwo\nthree\n", true); err != nil {
			t.Error(err)
		}
	}))
	f.session.beforeFinalWrite = func(attempt int) {
		if attempt == 1 {
			f.session.Doc.Transact(func(txn *crdt.Transaction) { f.session.Text.Insert(txn, 0, "minus\n", nil) })
		}
	}
	if err := f.session.Stop(); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.file); got != "minus\nzero\none\ntwo\nthree\n" {
		t.Fatalf("content = %q", got)
	}
	noTempLeft(t, filepath.Dir(f.file))
}

func TestStopLeavesTheNewestSaveOnDiskWhenSavesKeepLanding(t *testing.T) {
	needsExchange(t)
	f := setup(t, "one\n", setupOpts{writeDelay: time.Minute})
	g := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return g.String() == "one\n" }, "guest to sync")
	g.insert(0, "zero\n")
	prototest.WaitFor(t, wait, func() bool { return f.session.Text.ToString() == "zero\none\n" }, "host to see the edit")
	// A save lands in every write Stop makes. Stop runs them on this goroutine.
	saves, last := 0, ""
	f.session.bound.SetTestHook(func(s filewriter.Step) {
		if s != filewriter.StepBeforeReplace {
			return
		}
		saves++
		last = fmt.Sprintf("one\nsave %d\n", saves)
		if err := saveAs(f.file, last, true); err != nil {
			t.Error(err)
		}
	})
	err := f.session.Stop()
	if !errors.Is(err, filewriter.ErrExternalChange) || err.Error() != "file changed outside pedit" {
		t.Fatalf("Stop = %v", err)
	}
	// Each write was swapped back, so the editor's newest save is the file.
	if saves < 3 {
		t.Fatalf("only %d writes raced", saves)
	}
	if got := readFile(t, f.file); got != last {
		t.Fatalf("content = %q, want the newest save %q", got, last)
	}
	noTempLeft(t, filepath.Dir(f.file))
}

func TestJoinedCopyMergesASaveThatLandsWhilePeditWrites(t *testing.T) {
	f := setup(t, "one\ntwo\n", setupOpts{})
	browser := joinAsGuest(t, f.relay, f.session.URL)
	prototest.WaitFor(t, wait, func() bool { return browser.String() == "one\ntwo\n" }, "browser to sync")
	g, err := joinFromCLI(t, f, joinCLIOpts{})
	if err != nil {
		t.Fatal(err)
	}
	// The copy is saved in an editor while pedit writes an edit from the room.
	g.bound.SetTestHook(saveWhileWriting(1, func() {
		if err := saveAs(g.File(), "one\ntwo\nthree\n", true); err != nil {
			t.Error(err)
		}
	}))
	browser.insert(0, "zero\n")
	const merged = "zero\none\ntwo\nthree\n"
	prototest.WaitFor(t, wait, func() bool { return readFile(t, g.File()) == merged }, "the copy with both edits")
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == merged }, "the host's file")
	prototest.WaitFor(t, wait, func() bool { return browser.String() == merged }, "the browser")
	noTempLeft(t, filepath.Dir(g.File()))
}

func TestJoinDoesNotClobberAFileCreatedWhileItWritesTheCopy(t *testing.T) {
	// A host document with text is written through the Writer, an empty one
	// is created by Join itself; both must leave a file created meanwhile.
	for _, tt := range []struct{ name, host string }{
		{"a document with text", "# notes\n"},
		{"an empty document", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			f := setup(t, tt.host, setupOpts{})
			dir := t.TempDir()
			file := filepath.Join(dir, "notes.md")
			// Someone creates the copy between its check and the first write.
			hook := saveWhileWriting(1, func() {
				if err := os.WriteFile(file, []byte("mine\n"), 0o644); err != nil {
					t.Error(err)
				}
			})
			// A long delay keeps the writer's timer from taking the first write.
			_, err := joinFromCLI(t, f, joinCLIOpts{JoinOptions: JoinOptions{Directory: dir, WriteDelay: time.Minute, writeHook: hook}})
			if err == nil || err.Error() != "cannot write "+file+": file changed outside pedit" {
				t.Fatalf("err = %v", err)
			}
			if got := readFile(t, file); got != "mine\n" {
				t.Fatalf("file = %q", got)
			}
			entries, rerr := os.ReadDir(dir)
			if rerr != nil || len(entries) != 1 {
				t.Fatalf("directory = %v, %v", entries, rerr)
			}
			noTempLeft(t, dir)
		})
	}
}

func TestWritesAgainWhenAChangeIsUndoneBeforeItIsMerged(t *testing.T) {
	f := setup(t, "one\n", setupOpts{writeDelay: 500 * time.Millisecond})
	s := f.session
	// An edit waits to be written. Not through a guest: the test must hold the
	// write for the moment it chooses.
	s.Client.Do(func() {
		s.Doc.Transact(func(txn *crdt.Transaction) { s.Text.Insert(txn, 0, "zero\n", nil) })
	})
	s.Writer.Schedule(s.render())
	// The file is changed, and pedit finds it when it writes: the write is
	// skipped and a sync is scheduled.
	if err := os.WriteFile(f.file, []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.Writer.Flush(); !errors.Is(err, filewriter.ErrExternalChange) {
		t.Fatalf("Flush = %v", err)
	}
	// The change is undone before the sync reads the file.
	if err := os.WriteFile(f.file, []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prototest.WaitFor(t, wait, func() bool { return readFile(t, f.file) == "zero\none\n" }, "the skipped write to be saved")
}
