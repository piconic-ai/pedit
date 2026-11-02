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
	if err := bound.rename(".tmp"); err != nil {
		t.Fatalf("rename: %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "new\n" {
		t.Fatalf("file = %q", got)
	}
}
