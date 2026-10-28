package filewriter

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestHeldWriterNeverWritesOrLosesPendingOnFlush(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("local"), 0600); err != nil {
		t.Fatal(err)
	}
	w := New(path, "local", Options{Hold: true, Delay: time.Millisecond})
	w.Schedule("guest")
	time.Sleep(20 * time.Millisecond)
	if err := w.Flush(); !errors.Is(err, ErrRecoveryHeld) {
		t.Fatalf("flush: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != "local" {
		t.Fatalf("file %q: %v", got, err)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.pending == nil || *w.pending != "guest" {
		t.Fatal("pending content lost")
	}
}
