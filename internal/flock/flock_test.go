package flock

import (
	"os"
	"path/filepath"
	"testing"
)

func TestASecondHandleCannotTakeTheLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lock")
	a, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := TryLock(a); !ok || err != nil {
		t.Fatalf("first: %v %v", ok, err)
	}
	b, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if ok, err := TryLock(b); ok || err != nil {
		t.Fatalf("second while held: %v %v", ok, err)
	}
	_ = a.Close()
	if ok, err := TryLock(b); !ok || err != nil {
		t.Fatalf("second once released: %v %v", ok, err)
	}
}
