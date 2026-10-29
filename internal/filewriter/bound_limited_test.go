package filewriter

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBoundReadLimited(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	if err := os.WriteFile(path, []byte("abcd"), 0600); err != nil {
		t.Fatal(err)
	}
	bound, err := OpenBound(path)
	if err != nil {
		t.Fatal(err)
	}
	defer bound.Close()
	if got, ok := bound.ReadLimited(4); !ok || got != "abcd" {
		t.Fatalf("read %q %v", got, ok)
	}
	if _, ok := bound.ReadLimited(3); ok {
		t.Fatal("accepted oversized file")
	}
	if _, ok := bound.ReadLimited(int(^uint(0) >> 1)); ok {
		t.Fatal("accepted overflowing limit")
	}
	if _, ok := bound.ReadLimited(-1); ok {
		t.Fatal("accepted invalid limit")
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(filepath.Join(dir, "outside"), path); err != nil {
		t.Fatal(err)
	}
	if _, ok := bound.ReadLimited(100); ok {
		t.Fatal("followed symlink")
	}
}
