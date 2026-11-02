package filewriter

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRenameRetriesTransientFailures(t *testing.T) {
	oldB, oldT := renameBackoff, transient
	t.Cleanup(func() { renameBackoff, transient = oldB, oldT })
	renameBackoff = []time.Duration{time.Millisecond, time.Millisecond, time.Millisecond}
	busy := errors.New("sharing violation")
	transient = func(err error) bool { return errors.Is(err, busy) }

	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	bound, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	defer bound.Close()

	fails, calls := 2, 0
	real := bound.calls.rename
	bound.calls.rename = func(r *os.Root, a, b string) error {
		calls++
		if calls <= fails {
			return busy
		}
		return real(r, a, b)
	}
	if err := os.WriteFile(filepath.Join(dir, ".tmp"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := bound.rename(".tmp"); err != nil {
		t.Fatalf("rename after %d busy tries: %v", fails, err)
	}
	if got, _ := os.ReadFile(path); string(got) != "new" {
		t.Fatalf("file = %q, want new", got)
	}

	// Still busy after the last try: the error is reported, the file is whole.
	if err := os.WriteFile(filepath.Join(dir, ".tmp"), []byte("newer"), 0o600); err != nil {
		t.Fatal(err)
	}
	calls, fails = 0, 100
	if err := bound.rename(".tmp"); !errors.Is(err, busy) {
		t.Fatalf("err = %v, want the busy error", err)
	}
	if calls != 1+len(renameBackoff) {
		t.Fatalf("tried %d times, want %d", calls, 1+len(renameBackoff))
	}
	if got, _ := os.ReadFile(path); string(got) != "new" {
		t.Fatalf("file = %q, want it unchanged", got)
	}
}
