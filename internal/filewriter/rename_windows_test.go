//go:build windows

package filewriter

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// An editor or indexer that holds the file open without FILE_SHARE_DELETE
// blocks the replace; once it lets go within the backoff, the save lands.
func TestReplaceWaitsForAHolderWithoutShareDelete(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(path, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	name, _ := windows.UTF16PtrFromString(path)
	h, err := windows.CreateFile(name, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(150 * time.Millisecond)
		_ = windows.CloseHandle(h)
	}()

	bound, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	defer bound.Close()
	tmp := filepath.Join(dir, ".tmp")
	if err := os.WriteFile(tmp, []byte("new\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := bound.renameChecked("old\n", ".tmp"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "new\n" {
		t.Fatalf("file = %q", got)
	}
}

// A read-only target is refused for good: it is reported at once, not retried.
func TestReplaceDoesNotRetryAReadOnlyTarget(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(path, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(path, 0o600)
	bound, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	defer bound.Close()
	if err := os.WriteFile(filepath.Join(dir, ".tmp"), []byte("new\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	calls := 0
	real := bound.calls.rename
	bound.calls.rename = func(r *os.Root, a, b string) error { calls++; return real(r, a, b) }
	start := time.Now()
	if err := bound.renameChecked("old\n", ".tmp"); err == nil {
		t.Fatal("replaced a read-only file")
	}
	if calls > 2 || time.Since(start) > 500*time.Millisecond {
		t.Fatalf("retried: %d renames in %v", calls, time.Since(start))
	}
}
