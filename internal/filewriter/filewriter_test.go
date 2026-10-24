package filewriter

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func setup(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "a.md")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestWriteAtomic(t *testing.T) {
	path := setup(t, "old")
	if err := os.Chmod(path, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(path, "new"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, path); got != "new" {
		t.Fatalf("content = %q", got)
	}
	st, _ := os.Stat(path)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %v", st.Mode().Perm())
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("left files behind: %v", entries)
	}
}

func TestWriteAtomicIgnoresPlantedTempFile(t *testing.T) {
	for _, symlink := range []bool{false, true} {
		t.Run(fmt.Sprintf("symlink=%v", symlink), func(t *testing.T) {
			path := setup(t, "old")
			victim := filepath.Join(filepath.Dir(path), "private.txt")
			if err := os.WriteFile(victim, []byte("private"), 0o600); err != nil {
				t.Fatal(err)
			}
			planted := filepath.Join(filepath.Dir(path), fmt.Sprintf(".a.md.pedit-%d.tmp", os.Getpid()))
			if symlink {
				if err := os.Symlink(victim, planted); err != nil {
					if runtime.GOOS == "windows" {
						t.Skip(err)
					}
					t.Fatal(err)
				}
			} else if err := os.WriteFile(planted, []byte("planted"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := WriteAtomic(path, "new"); err != nil {
				t.Fatal(err)
			}
			if got := read(t, victim); got != "private" {
				t.Fatalf("victim changed: %q", got)
			}
			st, err := os.Stat(victim)
			if err != nil {
				t.Fatal(err)
			}
			if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
				t.Fatalf("victim mode = %v", st.Mode())
			}
			st, err = os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			if !st.Mode().IsRegular() || read(t, path) != "new" {
				t.Fatal("shared file was not replaced with a regular file")
			}
			want := "planted"
			if symlink {
				want = "private"
			}
			if got := read(t, planted); got != want {
				t.Fatalf("planted file changed: %q", got)
			}
			entries, err := os.ReadDir(filepath.Dir(path))
			if err != nil || len(entries) != 3 {
				t.Fatalf("temporary files leaked: %v, %v", entries, err)
			}
		})
	}
}

func TestWriteAtomicCleansUpAfterRenameFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "directory")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(path, "new"); err == nil {
		t.Fatal("expected rename failure")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary files leaked: %v, %v", entries, err)
	}
}

func TestReadFileReplacesInvalidUTF8(t *testing.T) {
	path := setup(t, "a\xffb")
	got, ok := ReadFile(path)
	if !ok || got != "a�b" {
		t.Fatalf("ReadFile = %q, %v", got, ok)
	}
	if _, ok := ReadFile(path + ".missing"); ok {
		t.Fatal("expected !ok for a missing file")
	}
}

func TestContinuousEditsSaveBeforeTheyStop(t *testing.T) {
	path := setup(t, "v0")
	w := New(path, "v0", Options{Delay: 40 * time.Millisecond})
	defer w.Flush()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		w.Schedule("latest")
		time.Sleep(5 * time.Millisecond)
		if got := read(t, path); got == "latest" {
			return
		}
	}
	t.Fatal("continuous edits never reached disk")
}

func TestCoalescesToLatestContent(t *testing.T) {
	path := setup(t, "v0")
	w := New(path, "v0", Options{Delay: 50 * time.Millisecond})
	w.Schedule("v1")
	w.Schedule("v2")
	if got := read(t, path); got != "v0" {
		t.Fatalf("wrote before delay: %q", got)
	}
	time.Sleep(100 * time.Millisecond)
	if got := read(t, path); got != "v2" {
		t.Fatalf("content = %q", got)
	}
}

func TestFlushWritesImmediately(t *testing.T) {
	path := setup(t, "v0")
	w := New(path, "v0", Options{Delay: time.Minute})
	w.Schedule("v1")
	w.Flush()
	if got := read(t, path); got != "v1" || w.LastWritten() != "v1" {
		t.Fatalf("content = %q, lastWritten = %q", got, w.LastWritten())
	}
}

func TestRefusesToClobberExternalChange(t *testing.T) {
	path := setup(t, "v0")
	called := 0
	w := New(path, "v0", Options{Delay: time.Minute, OnExternalChange: func() { called++ }})
	if err := os.WriteFile(path, []byte("edited elsewhere"), 0o644); err != nil {
		t.Fatal(err)
	}
	w.Schedule("v1")
	if err := w.Flush(); !errors.Is(err, ErrExternalChange) {
		t.Fatalf("Flush = %v", err)
	}
	if got := read(t, path); got != "edited elsewhere" || called != 1 {
		t.Fatalf("content = %q, called = %d", got, called)
	}
}

// A flush fired by the debounce timer while the file is busy must not land
// after, and overwrite, a later flush of newer content.
func TestFlushesLandInScheduleOrder(t *testing.T) {
	for range 20 {
		path := setup(t, "v0")
		w := New(path, "v0", Options{Delay: 5 * time.Millisecond})
		release := make(chan struct{})
		busy := make(chan struct{})
		go w.Rebase(func(last string) string {
			close(busy)
			<-release
			return last
		})
		<-busy
		w.Schedule("stale")
		time.Sleep(20 * time.Millisecond) // the timer fires and waits for the file
		w.Schedule("final")
		close(release)
		if err := w.Flush(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond) // let the timer's flush finish
		if got := read(t, path); got != "final" {
			t.Fatalf("content = %q", got)
		}
	}
}

func TestRebaseDropsContentComputedBeforeIt(t *testing.T) {
	path := setup(t, "v0")
	w := New(path, "v0", Options{Delay: time.Minute})
	w.Schedule("stale")
	if err := os.WriteFile(path, []byte("edited elsewhere"), 0o644); err != nil {
		t.Fatal(err)
	}
	w.Rebase(func(string) string { return "edited elsewhere" })
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	if got := read(t, path); got != "edited elsewhere" {
		t.Fatalf("content = %q", got)
	}
}
