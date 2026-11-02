package filewriter

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestReplaceRetriesTransientFailures(t *testing.T) {
	oldB, oldT := renameBackoff, transient
	t.Cleanup(func() { renameBackoff, transient = oldB, oldT })
	renameBackoff = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	busy := errors.New("sharing violation")
	transient = func(err error) bool { return errors.Is(err, busy) }

	setup := func(t *testing.T) (*BoundFile, string, string) {
		dir := t.TempDir()
		path := filepath.Join(dir, "a.txt")
		if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".tmp"), []byte("new"), 0o600); err != nil {
			t.Fatal(err)
		}
		bound, err := OpenBound(path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { bound.Close() })
		return bound, path, dir
	}
	read := func(path string) string {
		got, _ := os.ReadFile(path)
		return string(got)
	}

	t.Run("lands once the holder lets go", func(t *testing.T) {
		bound, path, _ := setup(t)
		calls := 0
		real := bound.calls.rename
		bound.calls.rename = func(r *os.Root, a, b string) error {
			if calls++; calls <= 2 {
				return busy
			}
			return real(r, a, b)
		}
		if err := bound.renameChecked("old", ".tmp"); err != nil {
			t.Fatal(err)
		}
		if got := read(path); got != "new" {
			t.Fatalf("file = %q, want new", got)
		}
	})

	t.Run("reports the error when the holder stays, leaving the file whole", func(t *testing.T) {
		bound, path, _ := setup(t)
		calls := 0
		bound.calls.rename = func(*os.Root, string, string) error { calls++; return busy }
		if err := bound.renameChecked("old", ".tmp"); !errors.Is(err, busy) {
			t.Fatalf("err = %v, want the busy error", err)
		}
		// Each try renames twice where the file is held open for the check (all but Windows).
		if want := 1 + len(renameBackoff); calls != want && calls != 2*want {
			t.Fatalf("renamed %d times, want %d tries", calls, want)
		}
		if got := read(path); got != "old" {
			t.Fatalf("file = %q, want it unchanged", got)
		}
	})

	t.Run("does not replace a save made while it waited", func(t *testing.T) {
		bound, path, _ := setup(t)
		calls := 0
		real := bound.calls.rename
		bound.calls.rename = func(r *os.Root, a, b string) error {
			if calls++; calls <= 2 {
				// An editor saves in place while the first try is refused.
				if err := os.WriteFile(path, []byte("editor save"), 0o600); err != nil {
					t.Error(err)
				}
				return busy
			}
			return real(r, a, b)
		}
		if err := bound.renameChecked("old", ".tmp"); !errors.Is(err, ErrExternalChange) {
			t.Fatalf("err = %v, want ErrExternalChange", err)
		}
		if got := read(path); got != "editor save" {
			t.Fatalf("file = %q, want the editor's save kept", got)
		}
	})
}
